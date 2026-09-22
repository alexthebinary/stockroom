/**
 * Void guards under PARTIAL payments and PARTIAL receipts.
 *
 * Both guards were written when those states could not exist:
 *   - void-invoice refused only `paymentStatus === "PAID"`, but a part-paid
 *     order sits at INVOICED.
 *   - void-bill refused only `status === "DELIVERED"`, but a part-received
 *     order stays POSTED.
 * Adding partial payments and partial receipts this session opened both.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { createLot } from "../src/costing";
import { ACCOUNT } from "../src/accounts";

let app: Express;
let token: string;
let warehouseId: number;
let vendorId: number;
let customerId: number;
let n = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Void WH", code: "VOIDWH" } })).id;
  vendorId = (await prisma.vendor.create({ data: { name: "Void Vendor" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Void Customer" } })).id;
});

async function stockedProduct(price: number) {
  n += 1;
  const p = await prisma.product.create({
    data: { sku: `VOID-${n}`, name: `Void ${n}`, brand: "Unitree", defaultPriceCents: price },
  });
  await prisma.inventoryBalance.create({
    data: { productId: p.id, warehouseId, onHandQty: 50 },
  });
  await prisma.$transaction((tx) =>
    createLot(tx, { productId: p.id, warehouseId, quantity: 50, unitCostCents: 1_000, sourceType: "TEST" })
  );
  return p.id;
}

async function accountNet(code: string) {
  const a = await prisma.account.findUniqueOrThrow({ where: { code } });
  const lines = await prisma.journalLine.findMany({ where: { accountId: a.id } });
  return lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

describe("void guards under partial states", () => {
  it("refuses to void an invoice that has a live partial payment", async () => {
    const api = as(app, token);
    const pid = await stockedProduct(10_000);
    const created = await api.post("/api/sales-orders").send({
      customerId, lines: [{ productId: pid, warehouseId, quantity: 4, unitPriceCents: 10_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/sales-orders/${id}/pack`);
    await api.post(`/api/sales-orders/${id}/invoice`);
    await api.post(`/api/sales-orders/${id}/pay`).send({ amountCents: 5_000 });

    // Part paid, so the order is INVOICED — which the old guard let through.
    expect((await api.get(`/api/sales-orders/${id}`)).body.paymentStatus).toBe("INVOICED");

    const arBefore = await accountNet(ACCOUNT.ACCOUNTS_RECEIVABLE);
    const voided = await api.post(`/api/sales-orders/${id}/void-invoice`);
    expect(voided.status).toBe(409);
    expect(String(voided.body.error)).toMatch(/payment/i);

    // The customer's money must still be attached to something.
    expect(await accountNet(ACCOUNT.ACCOUNTS_RECEIVABLE)).toBe(arBefore);
    const live = await prisma.payment.count({
      where: { invoice: { salesOrderId: id }, status: { not: "VOID" } },
    });
    expect(live).toBe(1);
  });

  it("still allows voiding an invoice with no payments against it", async () => {
    // The guard must not be so broad it blocks the ordinary case.
    const api = as(app, token);
    const pid = await stockedProduct(10_000);
    const created = await api.post("/api/sales-orders").send({
      customerId, lines: [{ productId: pid, warehouseId, quantity: 1, unitPriceCents: 10_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/sales-orders/${id}/pack`);
    await api.post(`/api/sales-orders/${id}/invoice`);
    expect((await api.post(`/api/sales-orders/${id}/void-invoice`)).status).toBe(200);
  });

  it("refuses to void a bill once any goods have been received against it", async () => {
    const api = as(app, token);
    const pid = await stockedProduct(5_000);
    const created = await api.post("/api/purchase-orders").send({
      vendorId, lines: [{ productId: pid, warehouseId, quantity: 10, unitCostCents: 5_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/purchase-orders/${id}/post`);
    const detail = await api.get(`/api/purchase-orders/${id}`);
    const lineId = detail.body.lines[0].id;

    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 3 }] });
    // Part received, so the order is still POSTED — what the old guard missed.
    expect((await api.get(`/api/purchase-orders/${id}`)).body.status).toBe("POSTED");

    const prepaidBefore = await accountNet(ACCOUNT.PREPAID_INVENTORY);
    const voided = await api.post(`/api/purchase-orders/${id}/void-bill`);
    expect(voided.status).toBe(409);
    expect(String(voided.body.error)).toMatch(/received/i);

    // Prepaid must not be credited a second time for goods already in stock.
    expect(await accountNet(ACCOUNT.PREPAID_INVENTORY)).toBe(prepaidBefore);
  });

  it("refuses to void a bill that has a live partial payment", async () => {
    const api = as(app, token);
    const pid = await stockedProduct(5_000);
    const created = await api.post("/api/purchase-orders").send({
      vendorId, lines: [{ productId: pid, warehouseId, quantity: 4, unitCostCents: 5_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/purchase-orders/${id}/post`);
    await api.post(`/api/purchase-orders/${id}/pay`).send({ amountCents: 1_000 });
    expect((await api.get(`/api/purchase-orders/${id}`)).body.status).toBe("POSTED");

    const voided = await api.post(`/api/purchase-orders/${id}/void-bill`);
    expect(voided.status).toBe(409);
    expect(String(voided.body.error)).toMatch(/payment/i);
  });

  it("still allows voiding an untouched bill", async () => {
    const api = as(app, token);
    const pid = await stockedProduct(5_000);
    const created = await api.post("/api/purchase-orders").send({
      vendorId, lines: [{ productId: pid, warehouseId, quantity: 2, unitCostCents: 5_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/purchase-orders/${id}/post`);
    expect((await api.post(`/api/purchase-orders/${id}/void-bill`)).status).toBe(200);
  });
});
