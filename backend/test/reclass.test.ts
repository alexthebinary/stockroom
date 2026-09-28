/**
 * One-time reclass (2026-09-28): invoices posted before the split booked tax
 * and shipping as revenue. One correcting entry per such invoice moves them
 * out — tax to 2200 (then its paid share to 2100), shipping to 4100 — and a
 * second run does nothing.
 *
 * "Old era" is simulated from a real HTTP flow by re-pointing the split lines
 * to 4000 and deleting the tax moves: exactly what an old posting looked like.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { RECLASS_MARKER, reclassHistoricalInvoices } from "../src/reclass";

/** Each test re-arms the one-time pass, as a fresh deploy would. */
const rearm = () => prisma.documentCounter.deleteMany({ where: { kind: { startsWith: RECLASS_MARKER } } });

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;
let productId: number;

const balance = async (code: string) =>
  (await as(app, token).get("/api/trial-balance")).body.accounts.find((a: { code: string }) => a.code === code)?.balanceCents ?? 0;

async function snapshot() {
  return { revenue: await balance("4000"), shipping: await balance("4100"), transition: await balance("2200"), payable: await balance("2100") };
}

beforeAll(async () => {
  ({ app, token } = await boot());
  const api = as(app, token);
  warehouseId = (await prisma.warehouse.create({ data: { name: "Reclass WH", code: "RCWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Reclass buyer" } })).id;
  productId = (await api.post("/api/products").send({ sku: "RC-1", name: "rc" })).body.id;
  await api.post("/api/stock-adjustments").send({
    productId, warehouseId, adjustmentType: "INCREASE", quantity: 50, reason: "t", unitCostCents: 4_000,
  });
});

async function shipped(channel: string, quantity: number, prepaid: boolean) {
  const api = as(app, token);
  const o = await api.post("/api/sales-orders").send({
    customerId, channel, taxCents: 800 * quantity, shippingCents: 1_000,
    lines: [{ productId, warehouseId, quantity, unitPriceCents: 10_000 }],
  });
  if (prepaid) await api.post(`/api/sales-orders/${o.body.id}/pay`).send({ method: "CARD" });
  await api.post(`/api/sales-orders/${o.body.id}/pack`);
  const s = await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body.order as { id: number; lines: { id: number }[]; invoices: { id: number }[] };
}

/** Rewrite an invoice's postings into the pre-split shape. */
async function makeOldEra(invoiceId: number) {
  const revenue = await prisma.account.findUniqueOrThrow({ where: { code: "4000" } });
  const split = await prisma.account.findMany({ where: { code: { in: ["2200", "4100"] } } });
  const creditNotes = await prisma.payment.findMany({ where: { invoiceId, method: "CREDIT_NOTE" } });
  const entries = await prisma.journalEntry.findMany({
    where: {
      OR: [
        { referenceType: "INVOICE", referenceId: invoiceId, transactionType: "SALES_INVOICE" },
        { referenceType: "PAYMENT", referenceId: { in: creditNotes.map((c) => c.id) }, transactionType: "SALES_RETURN" },
      ],
    },
  });
  await prisma.journalLine.updateMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) }, accountId: { in: split.map((a) => a.id) } },
    data: { accountId: revenue.id },
  });
  const moves = await prisma.journalEntry.findMany({ where: { referenceType: "INVOICE_TAX", referenceId: invoiceId } });
  await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: moves.map((m) => m.id) } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: moves.map((m) => m.id) } } });
}

describe("one-time reclass of historical invoices", () => {
  it("moves tax and shipping out of revenue, with the paid share of tax payable", async () => {
    const api = as(app, token);
    const order = await shipped("WHOLESALE", 1, false);
    await api.post(`/api/sales-orders/${order.id}/pay`).send({ amountCents: 5_900 }); // half
    await makeOldEra(order.invoices[0].id);
    await rearm();
    const before = await snapshot();

    const count = await reclassHistoricalInvoices();
    expect(count).toBeGreaterThanOrEqual(1);
    const after = await snapshot();
    expect(after.revenue - before.revenue).toBe(-1_800);
    expect(after.shipping - before.shipping).toBe(1_000);
    expect(after.transition - before.transition).toBe(400);
    expect(after.payable - before.payable).toBe(400);

    const entries = await prisma.journalEntry.count();
    expect(await reclassHistoricalInvoices()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(entries);
    expect((await api.get("/api/trial-balance")).body.sound).toBe(true);
  });

  it("reclasses only the tax still owed after a credit note", async () => {
    const api = as(app, token);
    const order = await shipped("SHOPIFY", 3, true); // 30_000 + 2_400 tax + 1_000 shipping, paid
    const ret = await api.post(`/api/sales-orders/${order.id}/returns`).send({
      reason: "t", lines: [{ lineId: order.lines[0].id, quantity: 1, disposition: "RESTOCK" }],
    });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    await makeOldEra(order.invoices[0].id);
    await rearm();
    const before = await snapshot();

    await reclassHistoricalInvoices();
    const after = await snapshot();
    // Revenue held 33_400 − 10_800; it should hold 30_000 − 10_000.
    expect(after.revenue - before.revenue).toBe(-2_600);
    expect(after.shipping - before.shipping).toBe(1_000);
    expect(after.payable - before.payable).toBe(1_600); // fully paid net of the refund
    expect(after.transition - before.transition).toBe(0);
  });

  it("leaves invoices posted with the split alone", async () => {
    await shipped("WHOLESALE", 1, false);
    await rearm();
    const entries = await prisma.journalEntry.count();
    expect(await reclassHistoricalInvoices()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(entries);
  });

  it("voiding a reclassed old invoice takes the reclass back out too", async () => {
    // Senior review 2026-09-28: void reversed only the old invoice entry, so
    // the reclass left −1,800 in 4000, +1,000 in 4100 and +800 in 2200 for an
    // invoice that no longer exists.
    const api = as(app, token);
    const order = await shipped("WHOLESALE", 1, false); // unpaid
    await makeOldEra(order.invoices[0].id);
    await rearm();
    await reclassHistoricalInvoices();
    const before = await snapshot();
    // Void from the reclassed state: everything this invoice put anywhere goes.
    const invoiceEffect = { revenue: -10_000, shipping: 0, transition: 0, payable: 0 };
    const v = await api.post(`/api/sales-orders/${order.id}/void-invoice`).send({ reason: "t" });
    expect(v.status, JSON.stringify(v.body)).toBeLessThan(300);
    const after = await snapshot();
    expect(after.revenue - before.revenue).toBe(invoiceEffect.revenue);
    expect(after.shipping - before.shipping).toBe(-1_000);
    expect(after.transition - before.transition).toBe(-800);
    expect(after.payable - before.payable).toBe(0);
  });

  it("runs once: after a completed pass, a later invoice that merely looks old is left alone", async () => {
    await rearm();
    await reclassHistoricalInvoices(); // completes and marks the pass done
    const order = await shipped("WHOLESALE", 1, false);
    await makeOldEra(order.invoices[0].id); // e.g. an admin repointed the tax/shipping lines
    const entries = await prisma.journalEntry.count();
    expect(await reclassHistoricalInvoices()).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(entries);
  });
});
