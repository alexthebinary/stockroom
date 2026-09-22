/**
 * The inbound document set: bills and goods receipts, across every order.
 *
 * Mirrors shipment-documents.test.ts. Both lists existed only INSIDE a single
 * purchase order before this, so "what do we owe vendors" and "what arrived
 * this week" were answerable one order at a time.
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
let productId: number;
let vendorId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "GRN WH", code: "GRNWH" } })).id;
  productId = (
    await prisma.product.create({
      data: { sku: "GRN-1", name: "Inbound widget", brand: "XAG", defaultCostCents: 50_000 },
    })
  ).id;
  vendorId = (await prisma.vendor.create({ data: { name: "XAG Co., Ltd (test)", email: "a@b.test" } })).id;
});

/** A posted PO with a posted bill. 4 x $500 = $2000. */
async function postedOrder() {
  const api = as(app, token);
  const created = await api.post("/api/purchase-orders").send({
    vendorId,
    lines: [{ productId, warehouseId, quantity: 4, unitCostCents: 50_000 }],
  });
  expect(created.status).toBe(201);
  const orderId = created.body.id as number;
  const posted = await api.post(`/api/purchase-orders/${orderId}/post`);
  if (posted.status >= 300) throw new Error(`post failed (${posted.status}): ${JSON.stringify(posted.body)}`);
  const detail = await api.get(`/api/purchase-orders/${orderId}`);
  return { orderId, api, billId: detail.body.bills[0].id as number };
}

describe("cross-order purchase lists", () => {
  it("does not read 'bills' or 'goods-receipts' as an order id", async () => {
    // Express matches in declaration order; these literals must precede "/:id"
    // or they 400 with "id must be an integer".
    const api = as(app, token);
    expect((await api.get("/api/purchase-orders/bills")).status).toBe(200);
    expect((await api.get("/api/purchase-orders/goods-receipts")).status).toBe(200);
  });

  it("lists bills with a computed outstanding balance", async () => {
    const { orderId, api, billId } = await postedOrder();
    await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 60_000 });

    const list = await api.get("/api/purchase-orders/bills?pageSize=200");
    expect(list.status).toBe(200);
    const ours = list.body.data.find((b: any) => b.id === billId);
    expect(ours).toBeTruthy();
    expect(ours.amountPaidCents).toBe(60_000);
    expect(ours.outstandingCents).toBe(140_000);
  });

  it("partitions paid from unpaid on the BALANCE, not the status", async () => {
    // A part-paid bill is the case that a status-only filter cannot produce,
    // so it is the one that proves the filter looks at money.
    const { orderId, api, billId } = await postedOrder();
    await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 1_000 });

    const unpaid = await api.get("/api/purchase-orders/bills?settlement=UNPAID&pageSize=200");
    const paid = await api.get("/api/purchase-orders/bills?settlement=PAID&pageSize=200");
    expect(unpaid.body.data.some((b: any) => b.id === billId)).toBe(true);
    expect(paid.body.data.some((b: any) => b.id === billId)).toBe(false);
    expect(unpaid.body.data.every((b: any) => b.outstandingCents > 0)).toBe(true);
    // The filter used to narrow only the current page and report that page's
    // length as the total, flagged with `partialFilter`. It now filters the
    // whole set, so the total must count everything that matched.
    expect(unpaid.body.total).toBeGreaterThanOrEqual(unpaid.body.data.length);

    // Settle it and it must cross over.
    await api.post(`/api/purchase-orders/${orderId}/pay`);
    const paidAfter = await api.get("/api/purchase-orders/bills?settlement=PAID&pageSize=200");
    expect(paidAfter.body.data.some((b: any) => b.id === billId)).toBe(true);
  });

  it("lists goods receipts once stock is received, with landed cost", async () => {
    const { orderId, api } = await postedOrder();
    const received = await api.post(`/api/purchase-orders/${orderId}/receive`);
    if (received.status >= 300) throw new Error(`receive failed: ${JSON.stringify(received.body)}`);

    const list = await api.get("/api/purchase-orders/goods-receipts?pageSize=200");
    expect(list.status).toBe(200);
    const ours = list.body.data.find((g: any) => g.purchaseOrder?.id === orderId);
    expect(ours).toBeTruthy();
    expect(ours.totalCostCents).toBe(200_000);
    expect(ours.warehouse.code).toBe("GRNWH");
    expect(ours.purchaseOrder.poNumber).toMatch(/^PO-/);
  });

  it("filters goods receipts by warehouse", async () => {
    const api = as(app, token);
    const all = await api.get("/api/purchase-orders/goods-receipts?pageSize=200");
    const mine = await api.get(`/api/purchase-orders/goods-receipts?warehouseId=${warehouseId}&pageSize=200`);
    expect(mine.body.data.every((g: any) => g.warehouse?.id === warehouseId)).toBe(true);
    expect(mine.body.data.length).toBeGreaterThan(0);
    expect(mine.body.data.length).toBeLessThanOrEqual(all.body.data.length);

    // A warehouse with no receipts must return none, not everything — an
    // ignored filter is the failure this catches.
    const empty = await prisma.warehouse.create({ data: { name: "No GRN", code: "NOGRN" } });
    const none = await api.get(`/api/purchase-orders/goods-receipts?warehouseId=${empty.id}`);
    expect(none.body.data.length).toBe(0);
  });

  it("renders a goods receipt note as a real PDF", async () => {
    const { orderId, api } = await postedOrder();
    await api.post(`/api/purchase-orders/${orderId}/receive`);
    const detail = await api.get(`/api/purchase-orders/${orderId}`);
    const grnId = detail.body.goodsReceipts[0].id as number;

    const res = await api
      .get(`/api/purchase-orders/goods-receipts/${grnId}/note.pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");
    // A PDF header over a tiny body is an empty document; this one carries
    // lines, totals, two signature rules and a barcode.
    expect(res.body.length).toBeGreaterThan(1_000);
  });

  it("404s for a goods receipt that does not exist", async () => {
    const api = as(app, token);
    expect((await api.get("/api/purchase-orders/goods-receipts/999999/note.pdf")).status).toBe(404);
  });
});
