/**
 * Customer returns, over HTTP, proved in the ledger.
 *
 * Every case ends by asking the two questions an accountant would: does the
 * trial balance still hold, and does the stock on the shelves still equal the
 * Inventory account. A return that restocks goods at the wrong cost, or credits
 * the customer without reversing revenue, fails one of those even when every
 * status field looks right.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { as, boot, prisma } from "./helpers";
import { ACCOUNT } from "../src/accounts";

let app: Express;
let token: string;
let warehouseId: number;
let otherWarehouseId: number;
let customerId: number;
let sku = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Ret WH", code: "RETWH" } })).id;
  otherWarehouseId = (await prisma.warehouse.create({ data: { name: "Ret WH2", code: "RETWH2" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Returning Customer" } })).id;
});

async function stocked(qty: number, cost: number, price: number) {
  sku += 1;
  const product = await prisma.product.create({
    data: { sku: `RET-${sku}`, name: `Ret ${sku}`, brand: "XAG", defaultCostCents: cost, defaultPriceCents: price },
  });
  const res = await as(app, token).post("/api/stock-adjustments").send({
    productId: product.id, warehouseId, adjustmentType: "INCREASE", quantity: qty, reason: "opening", unitCostCents: cost,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return product.id;
}

/** A shipped order. `prepaid` pays at checkout first; otherwise it ships on terms. */
async function shipped(channel: string, productId: number, quantity: number, taxCents = 0, prepaid = false) {
  const api = as(app, token);
  const o = await api.post("/api/sales-orders").send({
    customerId, channel, taxCents, lines: [{ productId, warehouseId, quantity }],
  });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  if (prepaid) expect((await api.post(`/api/sales-orders/${o.body.id}/pay`).send({ method: "CARD" })).status).toBe(201);
  await api.post(`/api/sales-orders/${o.body.id}/pack`);
  const s = await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body.order as { id: number; totalCents: number; lines: { id: number }[]; invoices: { id: number; totalCents: number }[] };
}

async function balance(code: string) {
  const tb = await as(app, token).get("/api/trial-balance");
  return tb.body.accounts.find((a: { code: string }) => a.code === code)?.balanceCents ?? 0;
}

async function booksHold() {
  const api = as(app, token);
  const tb = await api.get("/api/trial-balance");
  const val = await api.get("/api/reports/inventory-valuation");
  expect(tb.body.sound, JSON.stringify(tb.body.unbalancedEntries)).toBe(true);
  expect(val.body.varianceCents).toBe(0);
}

describe("returns", () => {
  it("prepaid order: restocked at the cost it left at, revenue reversed, card refunded", async () => {
    const api = as(app, token);
    const productId = await stocked(5, 1_000, 3_000);
    const order = await shipped("SHOPIFY", productId, 3, 900, true); // 9,000 goods + 900 tax
    const revenueBefore = await balance(ACCOUNT.SALES_REVENUE);
    const bankBefore = await balance(ACCOUNT.BANK);
    const cogsBefore = await balance(ACCOUNT.COGS);

    const res = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Wrong colour",
      lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.creditCents).toBe(3_300); // 3,000 + a third of the tax
    expect(res.body.refundCents).toBe(3_300); // they had paid in full
    expect(res.body.salesReturn.returnNumber).toMatch(/^RET-/);
    expect(res.body.order.paymentStatus).toBe("PAID");

    expect(await balance(ACCOUNT.SALES_REVENUE)).toBe(revenueBefore - 3_300);
    expect(await balance(ACCOUNT.BANK)).toBe(bankBefore - 3_300);
    expect(await balance(ACCOUNT.COGS)).toBe(cogsBefore - 1_000);
    const stock = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId, warehouseId } });
    expect(stock.onHandQty).toBe(3); // 5 − 3 shipped + 1 back

    // Margin ex-tax, net of the return: (9,000 − 3,000) − (3,000 − 1,000). Tax is not profit.
    const detail = await api.get(`/api/sales-orders/${order.id}`);
    expect(detail.body.margin).toEqual({ revenueCents: 6_000, costCents: 2_000, marginCents: 4_000, returnedCents: 3_000 });
    await booksHold();
  });

  it("unpaid wholesale invoice: a damaged return credits the receivable, refunds nothing, stays off the shelf", async () => {
    const api = as(app, token);
    const productId = await stocked(4, 2_000, 5_000);
    const order = await shipped("WHOLESALE", productId, 2);
    const arBefore = await balance(ACCOUNT.ACCOUNTS_RECEIVABLE);

    const res = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Arrived damaged",
      lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "WRITE_OFF" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.refundCents).toBe(0);
    expect(res.body.order.paymentStatus).toBe("INVOICED");
    expect(await balance(ACCOUNT.ACCOUNTS_RECEIVABLE)).toBe(arBefore - 5_000);
    const stock = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId, warehouseId } });
    expect(stock.onHandQty).toBe(2);

    // What is left to pay is the invoice less the credit; paying it settles.
    const paid = await api.post(`/api/sales-orders/${order.id}/pay`).send({});
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment.amountCents).toBe(5_000);
    expect(paid.body.order.paymentStatus).toBe("PAID");
    await booksHold();
  });

  it("restocks to another warehouse, and cannot return more than shipped across two returns", async () => {
    const api = as(app, token);
    const productId = await stocked(3, 1_500, 4_000);
    const order = await shipped("DIRECT", productId, 2);
    const lineId = order.lines[0].id;

    const first = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Changed mind",
      lines: [{ lineId, quantity: 1, disposition: "RESTOCK", warehouseId: otherWarehouseId }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const other = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId, warehouseId: otherWarehouseId } });
    expect(other.onHandQty).toBe(1);

    const tooMany = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Again", lines: [{ lineId, quantity: 2, disposition: "RESTOCK" }],
    });
    expect(tooMany.status).toBe(400);
    const rest = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Again", lines: [{ lineId, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(rest.status).toBe(201);
    await booksHold();
  });

  it("refuses an order that has not shipped, and a return with no reason", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 1_000, 2_000);
    const o = await api.post("/api/sales-orders").send({ customerId, channel: "DIRECT", lines: [{ productId, warehouseId, quantity: 1 }] });
    const notShipped = await api.post(`/api/sales-orders/${o.body.id}/returns`).send({
      reason: "x", lines: [{ lineId: o.body.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(notShipped.status).toBe(409);

    const order = await shipped("DIRECT", productId, 1);
    const noReason = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: " ", lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(noReason.status).toBe(400);
  });

  it("reverse-payment will not pick a credit note or refund off a return", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 1_000, 2_000);
    const order = await shipped("SHOPIFY", productId, 2, 0, true);
    await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "Too big", lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    const reversed = await api.post(`/api/sales-orders/${order.id}/reverse-payment`).send({ reason: "test" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.payment.method).not.toBe("CREDIT_NOTE");
    expect(reversed.body.payment.amountCents).toBeGreaterThan(0);
    await booksHold();
  });
});

describe("beta auto sign-in", () => {
  it("is off unless AUTO_LOGIN=1, and when on it issues a working admin session", async () => {
    delete process.env.AUTO_LOGIN;
    expect((await request(app).post("/api/auth/auto")).status).toBe(404);

    process.env.AUTO_LOGIN = "1";
    const res = await request(app).post("/api/auth/auto");
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("ADMIN");
    const me = await request(app).get("/api/auth/me").set("X-Stockroom-Session", res.body.token);
    expect(me.status).toBe(200);
    delete process.env.AUTO_LOGIN;
  });
});
