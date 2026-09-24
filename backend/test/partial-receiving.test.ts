/**
 * Partial goods receipts.
 *
 * `/purchase-orders/:id/receive` took every line at full quantity and flipped
 * the order to DELIVERED. `PurchaseOrderLine.receivedQty` existed, carried a
 * comment saying suppliers under-ship, and was never written to.
 *
 * The invariant that matters is the ledger one: the bill debits Prepaid
 * Inventory for the vendor's whole total, and however the deliveries are
 * split, the receipts must credit Prepaid by EXACTLY that total — no more, no
 * less, no residue stranded by rounding.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { ACCOUNT } from "../src/accounts";

let app: Express;
let token: string;
let warehouseId: number;
let otherWarehouseId: number;
let vendorId: number;
let sku = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Recv WH", code: "RECVWH" } })).id;
  otherWarehouseId = (await prisma.warehouse.create({ data: { name: "Recv WH2", code: "RECVWH2" } })).id;
  vendorId = (await prisma.vendor.create({ data: { name: "Partial Supplier" } })).id;
});

async function product(cost: number) {
  sku += 1;
  return (
    await prisma.product.create({
      data: { sku: `PARTIAL-${sku}`, name: `Partial ${sku}`, brand: "XAG", defaultCostCents: cost },
    })
  ).id;
}

/** A posted PO. `extras` exercises the landed-cost allocation. */
async function postedOrder(
  lines: { productId: number; warehouseId: number; quantity: number; unitCostCents: number }[],
  extras: { taxCents?: number; shippingCents?: number } = {}
) {
  const api = as(app, token);
  const created = await api.post("/api/purchase-orders").send({ vendorId, lines, ...extras });
  expect(created.status).toBe(201);
  const id = created.body.id as number;
  const posted = await api.post(`/api/purchase-orders/${id}/post`);
  if (posted.status >= 300) throw new Error(`post failed: ${JSON.stringify(posted.body)}`);
  const detail = await api.get(`/api/purchase-orders/${id}`);
  return { id, api, detail: detail.body };
}

/** Net movement on an account across every posted line. */
async function accountNet(code: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const lines = await prisma.journalLine.findMany({ where: { accountId: account.id } });
  return lines.reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);
}

describe("partial receiving", () => {
  it("receives part of a line and leaves the rest outstanding", async () => {
    const pid = await product(10_000);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 10, unitCostCents: 10_000 },
    ]);
    const lineId = detail.lines[0].id;

    const res = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId, quantity: 4 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(false);

    const after = await api.get(`/api/purchase-orders/${id}`);
    expect(after.body.lines[0].receivedQty).toBe(4);
    expect(after.body.lines[0].status).toBe("PARTIAL");
    // Still payable and receivable: an open back-order is not DELIVERED.
    expect(after.body.status).toBe("POSTED");

    const bal = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { productId_warehouseId: { productId: pid, warehouseId } },
    });
    expect(bal.onHandQty).toBe(4);
    expect(bal.incomingQty).toBe(6);
  });

  it("completes the order only when nothing is outstanding", async () => {
    const pid = await product(10_000);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 10, unitCostCents: 10_000 },
    ]);
    const lineId = detail.lines[0].id;

    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 3 }] });
    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 3 }] });
    expect((await api.get(`/api/purchase-orders/${id}`)).body.status).toBe("POSTED");

    const last = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId, quantity: 4 }],
    });
    expect(last.body.complete).toBe(true);
    const after = await api.get(`/api/purchase-orders/${id}`);
    expect(after.body.status).toBe("DELIVERED");
    expect(after.body.lines[0].status).toBe("RECEIVED");
    expect(after.body.goodsReceipts).toHaveLength(3);
  });

  it("clears Prepaid Inventory EXACTLY, however the deliveries are split", async () => {
    // 7 units at 33333 plus awkward extras: nothing here divides evenly, which
    // is the case where a naive proportional split strands cents in Prepaid.
    const pid = await product(33_333);
    const before = await accountNet(ACCOUNT.PREPAID_INVENTORY);
    const { id, api, detail } = await postedOrder(
      [{ productId: pid, warehouseId, quantity: 7, unitCostCents: 33_333 }],
      { taxCents: 1_777, shippingCents: 999 }
    );
    const lineId = detail.lines[0].id;
    const billTotal = detail.totalCents;

    const posted = await accountNet(ACCOUNT.PREPAID_INVENTORY);
    expect(posted - before).toBe(billTotal); // the bill put it there

    for (const q of [1, 2, 3, 1]) {
      const res = await api.post(`/api/purchase-orders/${id}/receive`).send({
        lines: [{ lineId, quantity: q }],
      });
      expect(res.status).toBe(200);
    }
    expect((await api.get(`/api/purchase-orders/${id}`)).body.status).toBe("DELIVERED");

    // Four deliveries, and Prepaid is back exactly where it started.
    expect(await accountNet(ACCOUNT.PREPAID_INVENTORY)).toBe(before);
  });

  it("receives across several lines independently", async () => {
    const a = await product(5_000);
    const b = await product(7_000);
    const { id, api, detail } = await postedOrder([
      { productId: a, warehouseId, quantity: 6, unitCostCents: 5_000 },
      { productId: b, warehouseId, quantity: 4, unitCostCents: 7_000 },
    ]);
    const [lineA, lineB] = detail.lines;

    // Only line A arrives on this pallet.
    await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId: lineA.id, quantity: 6 }, { lineId: lineB.id, quantity: 0 }],
    });
    const mid = await api.get(`/api/purchase-orders/${id}`);
    const byId = (id: number) => mid.body.lines.find((l: any) => l.id === id);
    expect(byId(lineA.id).status).toBe("RECEIVED");
    // Posting the order set every line ORDERED; an untouched line stays there.
    expect(byId(lineB.id).status).toBe("ORDERED");
    expect(byId(lineB.id).receivedQty).toBe(0);
    expect(mid.body.status).toBe("POSTED");

    await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId: lineB.id, quantity: 4 }],
    });
    expect((await api.get(`/api/purchase-orders/${id}`)).body.status).toBe("DELIVERED");
  });

  it("refuses more than is outstanding, and says how many are left", async () => {
    const pid = await product(1_000);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 5, unitCostCents: 1_000 },
    ]);
    const lineId = detail.lines[0].id;

    const over = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId, quantity: 6 }],
    });
    expect(over.status).toBe(400);
    expect(String(over.body.error)).toMatch(/only 5 outstanding/);

    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 3 }] });
    const creep = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId, quantity: 3 }],
    });
    expect(creep.status).toBe(400);
    expect(String(creep.body.error)).toMatch(/only 2 outstanding/);
  });

  it("rejects an empty receipt rather than posting a document for nothing", async () => {
    const pid = await product(1_000);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 2, unitCostCents: 1_000 },
    ]);
    const lineId = detail.lines[0].id;

    const zero = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId, quantity: 0 }],
    });
    expect(zero.status).toBe(400);

    await api.post(`/api/purchase-orders/${id}/receive`);
    // Now DELIVERED, so the lifecycle guard rejects it before the
    // nothing-to-receive check ever runs. 409, and the message says why.
    const again = await api.post(`/api/purchase-orders/${id}/receive`);
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/posted or paid/);
  });

  it("no body still receives everything, as it always did", async () => {
    const pid = await product(2_500);
    const { id, api } = await postedOrder([
      { productId: pid, warehouseId, quantity: 8, unitCostCents: 2_500 },
    ]);
    const res = await api.post(`/api/purchase-orders/${id}/receive`);
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    const after = await api.get(`/api/purchase-orders/${id}`);
    expect(after.body.status).toBe("DELIVERED");
    expect(after.body.lines[0].receivedQty).toBe(8);
  });

  it("names the warehouse only when THIS delivery lands in one", async () => {
    const a = await product(1_000);
    const b = await product(1_000);
    const { id, api, detail } = await postedOrder([
      { productId: a, warehouseId, quantity: 2, unitCostCents: 1_000 },
      { productId: b, warehouseId: otherWarehouseId, quantity: 2, unitCostCents: 1_000 },
    ]);
    const [lineA, lineB] = detail.lines;

    const one = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId: lineA.id, quantity: 2 }],
    });
    expect(one.body.goodsReceipt.warehouseId).toBe(warehouseId);

    const both = await api.post(`/api/purchase-orders/${id}/receive`).send({
      lines: [{ lineId: lineB.id, quantity: 2 }],
    });
    expect(both.body.goodsReceipt.warehouseId).toBe(otherWarehouseId);
  });

  it("creates one FIFO layer per delivery, not one per order", async () => {
    const pid = await product(4_000);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 6, unitCostCents: 4_000 },
    ]);
    const lineId = detail.lines[0].id;

    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 2 }] });
    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 4 }] });

    const lots = await prisma.inventoryLot.findMany({
      where: { productId: pid }, orderBy: { id: "asc" },
    });
    expect(lots.map((l) => l.originalQty)).toEqual([2, 4]);
    // Each layer traces to the delivery that created it.
    expect(new Set(lots.map((l) => l.sourceId)).size).toBe(2);
  });

  it("reports order coverage on the receipts list", async () => {
    const pid = await product(1_500);
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 10, unitCostCents: 1_500 },
    ]);
    const lineId = detail.lines[0].id;
    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 4 }] });

    let list = await api.get("/api/purchase-orders/goods-receipts?pageSize=200");
    let ours = list.body.data.find((g: any) => g.purchaseOrder.id === id);
    expect(ours.orderQuantity).toBe(10);
    expect(ours.orderReceivedQty).toBe(4);
    expect(ours.orderComplete).toBe(false);

    await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 6 }] });
    list = await api.get("/api/purchase-orders/goods-receipts?pageSize=200");
    // Both receipts for this order now report it complete.
    const all = list.body.data.filter((g: any) => g.purchaseOrder.id === id);
    expect(all).toHaveLength(2);
    expect(all.every((g: any) => g.orderComplete)).toBe(true);
    expect(all.every((g: any) => g.orderReceivedQty === 10)).toBe(true);
  });
});

describe("serial-tracked lines", () => {
  it("refuses a bulk receipt, because it would record stock with no serials", async () => {
    const pid = await product(50_000);
    await prisma.product.update({ where: { id: pid }, data: { trackingMode: "SERIAL" } });
    const { id, api, detail } = await postedOrder([
      { productId: pid, warehouseId, quantity: 2, unitCostCents: 50_000 },
    ]);
    const lineId = detail.lines[0].id;
    const lotsBefore = await prisma.inventoryLot.count({ where: { productId: pid } });

    const res = await api.post(`/api/purchase-orders/${id}/receive`).send({ lines: [{ lineId, quantity: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.details?.action).toBe("receive-serials");
    expect(await prisma.inventoryLot.count({ where: { productId: pid } })).toBe(lotsBefore);
  });
});
