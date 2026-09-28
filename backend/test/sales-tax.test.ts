/**
 * Revised mapping (2026-09-28): an invoice splits sales tax and shipping out
 * of revenue, and sales tax is payable on a cash basis — it sits in 2200 Sales
 * Tax Transition until the customer pays, then moves to 2100 Sales Tax Payable
 * in proportion to the cash received.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { syncSalesTaxPayable } from "../src/sales_tax";

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;
let productId: number;

async function balance(code: string) {
  const tb = await as(app, token).get("/api/trial-balance");
  return tb.body.accounts.find((a: { code: string }) => a.code === code)?.balanceCents ?? 0;
}
/** Trial-balance balances are already signed to the account's normal side. */
const credit = balance;

async function booksSound() {
  const tb = await as(app, token).get("/api/trial-balance");
  expect(tb.body.sound, JSON.stringify(tb.body.unbalancedEntries)).toBe(true);
}

beforeAll(async () => {
  ({ app, token } = await boot());
  const api = as(app, token);
  warehouseId = (await prisma.warehouse.create({ data: { name: "Tax WH", code: "TAXWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Tax buyer" } })).id;
  productId = (await api.post("/api/products").send({ sku: "TAX-1", name: "Taxed", defaultPriceCents: 10_000 })).body.id;
  const adj = await api.post("/api/stock-adjustments").send({
    productId, warehouseId, adjustmentType: "INCREASE", quantity: 50, reason: "t", unitCostCents: 4_000,
  });
  expect(adj.status).toBeLessThan(300);
});

/** Ship an order (terms channels are invoiced at shipment). */
async function shippedOrder(channel: string, quantity = 1, prepaid = false) {
  const api = as(app, token);
  const o = await api.post("/api/sales-orders").send({
    customerId, channel, taxCents: 800 * quantity, shippingCents: 1_000,
    lines: [{ productId, warehouseId, quantity, unitPriceCents: 10_000 }],
  });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  if (prepaid) expect((await api.post(`/api/sales-orders/${o.body.id}/pay`).send({ method: "CARD" })).status).toBe(201);
  await api.post(`/api/sales-orders/${o.body.id}/pack`);
  const s = await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const order = s.body.order as { id: number; lines: { id: number }[]; invoices: { id: number }[] };
  return { order, invoiceId: order.invoices[0].id };
}

describe("invoice split and cash-basis sales tax", () => {
  it("an invoice books goods to revenue, tax to 2200 and shipping to 4100", async () => {
    const { invoiceId } = await shippedOrder("WHOLESALE");
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { transactionType: "SALES_INVOICE", referenceId: invoiceId },
      include: { lines: { include: { account: true } } },
    });
    const byCode = Object.fromEntries(entry.lines.map((l) => [l.account.code, l.debitCents - l.creditCents]));
    expect(byCode).toEqual({ "1100": 11_800, "4000": -10_000, "2200": -800, "4100": -1_000 });
    await booksSound();
  });

  it("tax moves to 2100 in proportion to cash, and all of it once paid", async () => {
    const api = as(app, token);
    const payable0 = await credit("2100");
    const transition0 = await credit("2200");
    const { order, invoiceId } = await shippedOrder("WHOLESALE");
    expect(await credit("2200")).toBe(transition0 + 800);

    const half = await api.post(`/api/sales-orders/${order.id}/pay`).send({ amountCents: 5_900 });
    expect(half.status, JSON.stringify(half.body)).toBe(201);
    expect(await credit("2100")).toBe(payable0 + 400);
    expect(await credit("2200")).toBe(transition0 + 400);

    await api.post(`/api/sales-orders/${order.id}/pay`).send({});
    expect(await credit("2100")).toBe(payable0 + 800);
    expect(await credit("2200")).toBe(transition0);

    // A second sync moves nothing.
    const before = await prisma.journalEntry.count();
    await prisma.$transaction((tx) => syncSalesTaxPayable(tx, invoiceId, "test"));
    expect(await prisma.journalEntry.count()).toBe(before);
    await booksSound();
  });

  it("a checkout payment taken before the invoice makes all its tax payable at invoicing", async () => {
    const payable0 = await credit("2100");
    const transition0 = await credit("2200");
    await shippedOrder("SHOPIFY", 1, true);
    expect(await credit("2100")).toBe(payable0 + 800);
    expect(await credit("2200")).toBe(transition0);
    await booksSound();
  });

  it("a return with refund takes its tax share back out of payable", async () => {
    const api = as(app, token);
    const { order } = await shippedOrder("SHOPIFY", 3, true); // 30_000 + 2_400 tax + 1_000 shipping, paid
    const payable0 = await credit("2100");
    const transition0 = await credit("2200");
    const revenue0 = await credit("4000");
    const res = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "t", lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.creditCents).toBe(10_800); // 10_000 + a third of the tax
    expect(await credit("4000")).toBe(revenue0 - 10_000); // goods only
    // Tax still owed 1_600, fully paid after the refund → all of it payable.
    expect(await credit("2100")).toBe(payable0 - 800);
    expect(await credit("2200")).toBe(transition0);
    await booksSound();
  });

  it("voiding an unpaid invoice leaves no tax behind", async () => {
    const api = as(app, token);
    const payable0 = await credit("2100");
    const transition0 = await credit("2200");
    const { order } = await shippedOrder("WHOLESALE");
    const v = await api.post(`/api/sales-orders/${order.id}/void-invoice`).send({ reason: "t" });
    expect(v.status, JSON.stringify(v.body)).toBeLessThan(300);
    expect(await credit("2100")).toBe(payable0);
    expect(await credit("2200")).toBe(transition0);
    await booksSound();
  });

  it("a tax move cannot be reversed or unposted from the ledger screen", async () => {
    // Senior review 2026-09-28: a ledger reversal of a tax move was accepted,
    // and the sync (which counts its own moves) never saw it: 2100 stayed wrong.
    const api = as(app, token);
    const { order } = await shippedOrder("WHOLESALE");
    await api.post(`/api/sales-orders/${order.id}/pay`).send({ amountCents: 5_900 });
    const move = await prisma.journalEntry.findFirstOrThrow({
      where: { transactionType: "SALES_TAX_RECOGNIZED" }, orderBy: { id: "desc" },
    });
    const reverse = await api.post(`/api/journal-entries/${move.id}/reverse`);
    expect(reverse.status).toBe(409);
    const unpost = await api.post(`/api/journal-entries/${move.id}/unpost`);
    expect(unpost.status).toBe(409);
  });
});
