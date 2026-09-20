/**
 * SEQUENCES 2 and 3 of 3: cancelling a document the books already depend on.
 *
 * Both are the same failure in two shapes — a document is cancelled while the
 * ledger still carries what it put there, so revenue, a receivable or a cost
 * layer stands forever with nothing behind it. The guards exist in the cancel
 * handlers; nothing proved they fire.
 *
 * ⚠️ "./setup" MUST be first — it sets DATABASE_URL and src/db.ts constructs
 * PrismaClient at import time.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express;
let token: string;
let productId: number;
let warehouseId: number;
let customerId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  const wh = await prisma.warehouse.create({ data: { name: "Test WH", code: "TWH" } });
  warehouseId = wh.id;
  const p = await prisma.product.create({
    data: { sku: "TEST-SKU-1", name: "Test Widget", defaultPriceCents: 10_000 },
  });
  productId = p.id;
  const c = await prisma.customer.create({ data: { name: "Test Customer" } });
  customerId = c.id;
});

async function newOrder() {
  const res = await as(app, token)
    .post("/api/sales-orders")
    .send({ customerId, lines: [{ productId, warehouseId, quantity: 1, unitPriceCents: 10_000 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe("sequence 2 — cancelling an invoiced, then a paid, sales order", () => {
  it("CONTROL: an untouched order cancels cleanly", async () => {
    // Without this, every assertion below could pass because cancel is broken
    // for all orders, which looks identical to the guards working.
    const order = await newOrder();
    const res = await as(app, token).post(`/api/sales-orders/${order.id}/cancel`).send({});
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  });

  it("refuses to cancel once an invoice has put revenue on the books", async () => {
    const order = await newOrder();
    const inv = await as(app, token).post(`/api/sales-orders/${order.id}/invoice`).send({});
    expect([200, 201], JSON.stringify(inv.body)).toContain(inv.status);

    const res = await as(app, token).post(`/api/sales-orders/${order.id}/cancel`).send({});
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/invoiced/i);

    // The order must be untouched. A rejected cancel that still moved status
    // is worse than one that succeeded — nothing would report it.
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.readinessStatus).not.toBe("CANCELED");
  });

  it("refuses to cancel a PAID order, and names the payment to reverse", async () => {
    const order = await newOrder();
    await as(app, token).post(`/api/sales-orders/${order.id}/invoice`).send({});
    const pay = await as(app, token)
      .post(`/api/sales-orders/${order.id}/pay`)
      .send({ amountCents: 10_000 });
    expect([200, 201], JSON.stringify(pay.body)).toContain(pay.status);

    const res = await as(app, token).post(`/api/sales-orders/${order.id}/cancel`).send({});
    expect(res.status).toBe(409);
    // The guard must hand the UI something to click, not just refuse.
    expect(String(res.body.error)).toMatch(/paid|reverse/i);
  });
});

describe("sequence 3 — cancelling a posted purchase order", () => {
  it("refuses to cancel a PO whose receipt already created cost layers", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "Test Vendor 2" } });
    const created = await as(app, token)
      .post("/api/purchase-orders")
      .send({
        vendorId: vendor.id,
        lines: [{ productId, warehouseId, quantity: 4, unitCostCents: 2_500 }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const poId = created.body.id;

    // A PO must be POSTED before it can be received: SAVED -> /post -> POSTED -> /receive.
    const posted = await as(app, token).post(`/api/purchase-orders/${poId}/post`).send({});
    expect([200, 201], JSON.stringify(posted.body)).toContain(posted.status);

    const recv = await as(app, token).post(`/api/purchase-orders/${poId}/receive`).send({});
    expect([200, 201], JSON.stringify(recv.body)).toContain(recv.status);

    // Receiving created FIFO cost layers and moved stock. Cancelling now would
    // leave inventory on hand with no document behind it.
    const lots = await prisma.inventoryLot.count({ where: { productId } });
    expect(lots, "receiving must have created at least one cost layer").toBeGreaterThan(0);

    const res = await as(app, token).post(`/api/purchase-orders/${poId}/cancel`).send({});
    expect([400, 409]).toContain(res.status);

    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    expect(after.status).not.toBe("CANCELED");
  });
});
