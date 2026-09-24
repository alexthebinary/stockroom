/**
 * The Payments pages (Sales → Payments, Purchases → Payments), over HTTP.
 *
 * The register only READS; registering goes through the order routes. So the
 * proof is: what the open list offers is exactly what those routes accept, and
 * a payment made there shows up in the register and shrinks the open amount.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Pay WH", code: "PAYWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Paying Customer" } })).id;
});

type Open = { kind: string; id: number; payPath: string; label: string; outstandingCents: number; totalCents: number };

describe("payments register", () => {
  it("receipts: an invoiced order is open, a part payment shrinks it and lands in the register", async () => {
    const api = as(app, token);
    const product = await prisma.product.create({ data: { sku: "PAY-1", name: "Pay 1", defaultCostCents: 1_000, defaultPriceCents: 3_000 } });
    await api.post("/api/stock-adjustments").send({
      productId: product.id, warehouseId, adjustmentType: "INCREASE", quantity: 2, reason: "opening", unitCostCents: 1_000,
    });
    const o = await api.post("/api/sales-orders").send({ customerId, channel: "WHOLESALE", lines: [{ productId: product.id, warehouseId, quantity: 2 }] });
    await api.post(`/api/sales-orders/${o.body.id}/pack`);
    expect((await api.post(`/api/sales-orders/${o.body.id}/ship`).send({})).status).toBe(200);

    const open = (await api.get("/api/payments/open?direction=RECEIPT")).body.data as Open[];
    const row = open.find((r) => r.id === o.body.id)!;
    expect(row.kind).toBe("invoice");
    expect(row.outstandingCents).toBe(6_000);

    // Register exactly as the page does: through the row's own pay path.
    const paid = await api.post(`/api${row.payPath}`).send({ amountCents: 2_500, method: "CHECK" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const after = (await api.get("/api/payments/open?direction=RECEIPT")).body.data as Open[];
    expect(after.find((r) => r.id === o.body.id)!.outstandingCents).toBe(3_500);
    const reg = await api.get("/api/payments?direction=RECEIPT");
    const mine = reg.body.data.find((p: { paymentNumber: string }) => p.paymentNumber === paid.body.payment.paymentNumber);
    expect(mine).toMatchObject({ amountCents: 2_500, method: "CHECK", party: "Paying Customer" });
    expect(mine.against).toMatch(/^INV-/);

    // Settling it takes it off the open list.
    await api.post(`/api${row.payPath}`).send({});
    const settled = (await api.get("/api/payments/open?direction=RECEIPT")).body.data as Open[];
    expect(settled.find((r) => r.id === o.body.id)).toBeUndefined();
  });

  it("disbursements list only bills with a balance, and a bad direction is refused", async () => {
    const api = as(app, token);
    const open = await api.get("/api/payments/open?direction=DISBURSEMENT");
    expect(open.status).toBe(200);
    for (const r of open.body.data as Open[]) {
      expect(r.kind).toBe("bill");
      expect(r.outstandingCents).toBeGreaterThan(0);
      expect(r.payPath).toMatch(/^\/purchase-orders\/\d+\/pay$/);
    }
    expect((await api.get("/api/payments?direction=SIDEWAYS")).status).toBe(400);
  });
});
