/**
 * The camera receiving flow must book stock the same way the manual one does.
 *
 * /receiving/scan incremented onHandQty and receivedQty and stopped there. No
 * incomingQty decrement, no GoodsReceipt, no InventoryMovement, no cost layer
 * for non-serialised goods, and no journal entry — so every gloved scan on the
 * dock added physical stock that the books did not know about, Prepaid
 * Inventory was never cleared, and the resulting units had no FIFO layer to
 * consume when they later shipped.
 *
 * This is the flagship feature. It was the least correct code in the app.
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
let vendorId: number;
let n = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Scan Dock", code: "SCANDK" } })).id;
  vendorId = (await prisma.vendor.create({ data: { name: "Scan Vendor" } })).id;
});

const readers = (text: string) => [
  { id: "deepseek-vision", family: "deepseek", text, confidence: 0.94 },
  { id: "llama-vision", family: "llama", text, confidence: 0.91 },
];

/** A posted PO with one line, serialised or not. */
async function postedLine(serialized: boolean, quantity = 3, unitCostCents = 100_000) {
  n += 1;
  const product = await prisma.product.create({
    data: {
      sku: `SCAN-${n}`,
      name: `Scan ${n}`,
      brand: "Unitree",
      trackingMode: serialized ? "SERIAL" : "NONE",
    },
  });
  const api = as(app, token);
  const created = await api.post("/api/purchase-orders").send({
    vendorId,
    lines: [{ productId: product.id, warehouseId, quantity, unitCostCents }],
  });
  const poId = created.body.id as number;
  const posted = await api.post(`/api/purchase-orders/${poId}/post`).send({});
  if (posted.status >= 300) throw new Error(`post failed: ${JSON.stringify(posted.body)}`);
  const full = await api.get(`/api/purchase-orders/${poId}`);
  return { api, poId, productId: product.id, lineId: full.body.lines[0].id as number };
}

async function accountNet(code: string) {
  const a = await prisma.account.findUniqueOrThrow({ where: { code } });
  const lines = await prisma.journalLine.findMany({ where: { accountId: a.id } });
  return lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

describe("camera receiving books stock properly", () => {
  it("moves a unit from incoming to on hand, not just on hand", async () => {
    const { api, productId, lineId } = await postedLine(false);
    const before = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    expect(before.incomingQty).toBe(3);

    const res = await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "BOX-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("received");

    const after = await prisma.inventoryBalance.findUniqueOrThrow({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    expect(after.onHandQty).toBe(before.onHandQty + 1);
    // The half that was missing: stock cannot be both incoming and on hand.
    expect(after.incomingQty).toBe(2);
  });

  it("creates a cost layer for NON-serialised goods", async () => {
    const { api, productId, lineId } = await postedLine(false);
    await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "BOX-2" });

    const lots = await prisma.inventoryLot.findMany({ where: { productId } });
    expect(lots).toHaveLength(1);
    expect(lots[0].originalQty).toBe(1);
    // Without a layer these units have no cost, and shipping them later
    // either fails the FIFO check or silently consumes someone else's.
    expect(lots[0].unitCostCents).toBeGreaterThan(0);
  });

  it("records a goods receipt and a stock movement", async () => {
    const { api, poId, lineId } = await postedLine(false);
    await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "BOX-3" });

    const grns = await prisma.goodsReceipt.findMany({ where: { purchaseOrderId: poId } });
    expect(grns.length).toBeGreaterThanOrEqual(1);

    const movements = await prisma.inventoryMovement.findMany({
      where: { referenceType: "GOODS_RECEIPT", referenceId: grns[0].id },
    });
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0].movementType).toBe("PURCHASE_RECEIPT");
  });

  it("posts a balanced journal entry that clears Prepaid Inventory", async () => {
    const { api, lineId } = await postedLine(false);
    const invBefore = await accountNet(ACCOUNT.INVENTORY);
    const prepaidBefore = await accountNet(ACCOUNT.PREPAID_INVENTORY);

    await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "BOX-4" });

    const invAfter = await accountNet(ACCOUNT.INVENTORY);
    const prepaidAfter = await accountNet(ACCOUNT.PREPAID_INVENTORY);
    // Stock arrived: Inventory up, Prepaid down. Neither moved before.
    expect(invAfter).toBeGreaterThan(invBefore);
    expect(prepaidAfter).toBeLessThan(prepaidBefore);
  });

  it("clears Prepaid EXACTLY when a whole line is scanned in one at a time", async () => {
    const { api, lineId } = await postedLine(false, 3, 33_333);
    const before = await accountNet(ACCOUNT.PREPAID_INVENTORY);
    // Whatever the bill put there for this line must come back out.
    const line = await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    const order = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: line.purchaseOrderId } });

    for (const box of [1, 2, 3]) {
      const r = await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: `B${box}` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect(await accountNet(ACCOUNT.PREPAID_INVENTORY)).toBe(before - order.totalCents);
  });

  it("still works for serialised goods, and gives the unit ONE cost layer", async () => {
    // UT900001, not UTSCAN01: Unitree serials are two letters then digits
    // (serial_intake.ts), and the adjudicator correctly refuses anything else.
    const { api, lineId } = await postedLine(true);
    const res = await api.post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId, readers: readers("UT900001"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.serial).toBe("UT900001");
    const unit = await prisma.serialUnit.findFirstOrThrow({ where: { serialNumber: "UT900001" } });
    expect(unit.lotId, "a received unit is owned stock").not.toBeNull();

    // The hazard this nearly shipped with: the receipt pipeline creates a
    // layer AND receiveSerials used to create its own, so one unit would have
    // carried two layers and the same money would be counted twice.
    const lots = await prisma.inventoryLot.findMany({ where: { productId: unit.productId } });
    expect(lots).toHaveLength(1);
    expect(lots[0].id).toBe(unit.lotId);
  });

  it("completes the order once the last box is scanned", async () => {
    const { api, poId, lineId } = await postedLine(false, 2);
    await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "L1" });
    expect((await api.get(`/api/purchase-orders/${poId}`)).body.status).toBe("POSTED");
    await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "L2" });
    expect((await api.get(`/api/purchase-orders/${poId}`)).body.status).toBe("DELIVERED");
  });

  it("refuses to scan past the quantity ordered", async () => {
    const { api, lineId } = await postedLine(false, 1);
    expect((await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "X1" })).status).toBe(200);
    const over = await api.post("/api/receiving/scan").send({ purchaseOrderLineId: lineId, barcode: "X2" });
    expect(over.status).toBe(400);
  });
});
