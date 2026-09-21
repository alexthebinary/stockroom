/**
 * The outbound document set: invoice -> payment -> delivery.
 *
 * Two things are pinned here that a green test suite previously could not see:
 *
 *   - `trackingUrl` is DERIVED, so it has to be attached on every read path.
 *     POST /tracking returned it and both GETs did not, which meant the link
 *     appeared when you saved a number and vanished when you reloaded.
 *   - The Code 128 checksum. A wrong modulo-103 sum still renders a plausible
 *     barcode that no scanner will read, and nothing downstream would fail.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { code128bModules } from "../src/pdf";
import { createLot } from "../src/costing";
import { trackingUrl } from "../src/carriers";

let app: Express;
let token: string;
let warehouseId: number;
let productId: number;
let customerId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Doc WH", code: "DOCWH" } })).id;
  productId = (
    await prisma.product.create({
      data: { sku: "DOC-1", name: "Document widget", brand: "Unitree", defaultPriceCents: 5_000 },
    })
  ).id;
  customerId = (
    await prisma.customer.create({
      data: { name: "Dockside Ltd", email: "ops@dockside.test", address: "12 Quay St\nHalifax NS" },
    })
  ).id;
});

/** An order taken all the way to SHIPPED, which is what produces a Shipment. */
async function shippedOrder() {
  const api = as(app, token);

  await prisma.inventoryBalance.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: { productId, warehouseId, onHandQty: 50, reservedQty: 0 },
    update: { onHandQty: { increment: 50 } },
  });
  await prisma.$transaction((tx) =>
    createLot(tx, {
      productId,
      warehouseId,
      quantity: 50,
      unitCostCents: 2_000,
      sourceType: "TEST",
    })
  );

  const created = await api.post("/api/sales-orders").send({
    customerId,
    lines: [{ productId, warehouseId, quantity: 3, unitPriceCents: 5_000 }],
  });
  expect(created.status).toBe(201);
  const orderId = created.body.id as number;

  // The verbs do not agree on 200 vs 201, and which one they return is not
  // what this file is testing — but a silent 409 would make every assertion
  // below meaningless, so the body is surfaced on failure.
  for (const verb of ["pack", "invoice", "pay", "ship"]) {
    const res = await api.post(`/api/sales-orders/${orderId}/${verb}`);
    if (res.status >= 300) throw new Error(`${verb} failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  const detail = await api.get(`/api/sales-orders/${orderId}`);
  expect(detail.status).toBe(200);
  return { orderId, detail: detail.body, api };
}

describe("Code 128B", () => {
  it("encodes a known symbol exactly, checksum included", () => {
    // Start B (104) + 'A' (33) + checksum (104 + 33) % 103 = 34 + Stop (106).
    const expected = "211214" + "111323" + "131123" + "2331112";
    expect(code128bModules("A").join("")).toBe(expected);
  });

  it("weights the checksum by position, so a transposition changes it", () => {
    // The whole point of the modulo-103 sum. If position were ignored these
    // two would encode identically and the test would be measuring nothing.
    expect(code128bModules("AB")).not.toEqual(code128bModules("BA"));
  });

  it("always starts on a bar and ends with the stop pattern", () => {
    const modules = code128bModules("SHP-000123");
    expect(modules.length % 2).toBe(1); // stop is 7 elements, so the total is odd
    expect(modules.slice(-7).join("")).toBe("2331112");
  });

  it("drops characters it cannot encode rather than throwing", () => {
    expect(() => code128bModules("SHPÿ-1")).not.toThrow();
    expect(code128bModules("SHPÿ-1")).toEqual(code128bModules("SHP-1"));
  });
});

describe("tracking", () => {
  it("attaches trackingUrl on the order read, not only on the write", async () => {
    const { orderId, detail, api } = await shippedOrder();
    const shipmentId = detail.shipments[0].id as number;

    // Before a number exists there is nothing to link to, and the field must
    // still be present rather than absent — the UI branches on null, not on
    // undefined.
    expect(detail.shipments[0].trackingUrl).toBeNull();

    const saved = await api
      .post(`/api/sales-orders/shipments/${shipmentId}/tracking`)
      .send({ carrier: "UPS", trackingNumber: "1Z999AA10123456784" });
    expect(saved.status).toBe(200);
    expect(saved.body.trackingUrl).toBe(trackingUrl("UPS", "1Z999AA10123456784"));

    // The regression this test exists for: reload and the link must survive.
    const reread = await api.get(`/api/sales-orders/${orderId}`);
    expect(reread.body.shipments[0].trackingUrl).toBe(saved.body.trackingUrl);
    expect(reread.body.shipments[0].carrier).toBe("UPS");

    const list = await api.get(`/api/sales-orders?search=${reread.body.orderNumber}`);
    expect(list.body.data[0].shipments[0].trackingUrl).toBe(saved.body.trackingUrl);
  });

  it("marks delivered and retracts it without touching stock or the ledger", async () => {
    const { detail, api } = await shippedOrder();
    const shipmentId = detail.shipments[0].id as number;

    const movementsBefore = await prisma.inventoryMovement.count();
    const entriesBefore = await prisma.journalEntry.count();

    const delivered = await api
      .post(`/api/sales-orders/shipments/${shipmentId}/tracking`)
      .send({ delivered: true });
    expect(delivered.status).toBe(200);
    expect(delivered.body.deliveredAt).not.toBeNull();

    const retracted = await api
      .post(`/api/sales-orders/shipments/${shipmentId}/tracking`)
      .send({ delivered: false });
    expect(retracted.body.deliveredAt).toBeNull();

    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await prisma.journalEntry.count()).toBe(entriesBefore);
  });
});

describe("cross-order lists", () => {
  it("lists invoices with a computed outstanding balance", async () => {
    await shippedOrder(); // paid in full
    const api = as(app, token);

    const all = await api.get("/api/sales-orders/invoices");
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThan(0);

    const invoice = all.body.data[0];
    expect(invoice.outstandingCents).toBe(
      Math.max(invoice.totalCents - invoice.amountPaidCents, 0)
    );

    // The filter must actually partition. A filter that returns everything is
    // the failure mode a "it returned 200" assertion cannot see.
    const paid = await api.get("/api/sales-orders/invoices?settlement=PAID");
    const unpaid = await api.get("/api/sales-orders/invoices?settlement=UNPAID");
    expect(paid.body.data.every((i: any) => i.outstandingCents === 0)).toBe(true);
    expect(unpaid.body.data.every((i: any) => i.outstandingCents > 0)).toBe(true);
    expect(paid.body.data.length).toBeGreaterThan(0);
  });

  it("lists deliveries and separates in-transit from delivered", async () => {
    const { detail, api } = await shippedOrder();
    const shipmentId = detail.shipments[0].id as number;

    const inTransit = await api.get("/api/sales-orders/shipments?delivered=NO");
    expect(inTransit.status).toBe(200);
    expect(inTransit.body.data.some((s: any) => s.id === shipmentId)).toBe(true);
    expect(inTransit.body.data.every((s: any) => s.deliveredAt === null)).toBe(true);

    await api.post(`/api/sales-orders/shipments/${shipmentId}/tracking`).send({ delivered: true });

    const stillInTransit = await api.get("/api/sales-orders/shipments?delivered=NO");
    expect(stillInTransit.body.data.some((s: any) => s.id === shipmentId)).toBe(false);

    const done = await api.get("/api/sales-orders/shipments?delivered=YES");
    expect(done.body.data.some((s: any) => s.id === shipmentId)).toBe(true);
  });

  it("does not read 'invoices' or 'shipments' as an order id", async () => {
    // Express matches in declaration order; these literals must be declared
    // before "/:id" or they 400 with "id must be an integer".
    const api = as(app, token);
    expect((await api.get("/api/sales-orders/invoices")).status).toBe(200);
    expect((await api.get("/api/sales-orders/shipments")).status).toBe(200);
  });
});

describe("shipment documents", () => {
  it("renders a packing slip and a 4x6 label as real PDFs", async () => {
    const { detail, api } = await shippedOrder();
    const shipmentId = detail.shipments[0].id as number;

    for (const path of ["packing-slip", "label"]) {
      const res = await api
        .get(`/api/sales-orders/shipments/${shipmentId}/${path}.pdf`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
      // A PDF header on a 200-byte body is an empty document. The slip carries
      // lines and a barcode, so it cannot be small.
      expect(res.body.length).toBeGreaterThan(1_000);
    }
  });

  it("404s for a shipment that does not exist", async () => {
    const api = as(app, token);
    expect((await api.get("/api/sales-orders/shipments/999999/label.pdf")).status).toBe(404);
  });
});
