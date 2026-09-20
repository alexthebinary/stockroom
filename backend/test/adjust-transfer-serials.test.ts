/**
 * Two operator decisions from 2026-09-19, encoded so they cannot silently drift:
 *
 *   - A serialized write-off MUST name its units. Scrapping "one of these" is
 *     not a record anyone can act on, and a vendor warranty claim IS the serial.
 *   - Serialized stock CANNOT be transferred between warehouses yet, because a
 *     transfer consumes and recreates the cost layer, which would sever the
 *     SerialUnit -> lot link the design rests on.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { receiveSerials } from "../src/serials";
import { applyBalanceDelta } from "../src/inventory";
import { createLot } from "../src/costing";

let app: Express;
let token: string;
let warehouseId: number;
let otherWarehouseId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Adj WH", code: "AWH" } })).id;
  otherWarehouseId = (await prisma.warehouse.create({ data: { name: "Adj WH2", code: "AWH2" } })).id;
});

async function serialized(sku: string, serials: string[]) {
  const p = await prisma.product.create({
    data: { sku, name: `S ${sku}`, brand: "Unitree", trackingMode: "SERIAL" },
  });
  await prisma.$transaction(async (tx) => {
    await receiveSerials(tx, {
      productId: p.id, warehouseId, unitCostCents: 200_000,
      serials: serials.map((s) => ({ serialNumber: s })), sourceType: "TEST",
    });
    await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: serials.length }, "seed");
  });
  return p;
}

describe("serialized write-offs", () => {
  it("refuses a DECREASE that does not name the units", async () => {
    const p = await serialized("ADJ-UT-1", ["D-1", "D-2"]);
    const res = await as(app, token).post("/api/stock-adjustments").send({
      productId: p.id, warehouseId, adjustmentType: "DECREASE",
      quantity: 1, reason: "dropped",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/serial-tracked/i);
    expect(res.body.details?.action).toBe("scan-serials");
    expect(await prisma.serialUnit.count({ where: { productId: p.id, status: "IN_STOCK" } })).toBe(2);
  });

  it("scraps exactly the named unit and leaves the other in stock", async () => {
    const p = await serialized("ADJ-UT-2", ["E-1", "E-2"]);
    const res = await as(app, token).post("/api/stock-adjustments").send({
      productId: p.id, warehouseId, adjustmentType: "DECREASE",
      quantity: 1, reason: "cracked shell", serialNumbers: ["E-2"],
    });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    const scrapped = await prisma.serialUnit.findMany({
      where: { productId: p.id, status: "SCRAPPED" }, select: { serialNumber: true },
    });
    expect(scrapped.map((s) => s.serialNumber)).toEqual(["E-2"]);

    const left = await prisma.serialUnit.findMany({
      where: { productId: p.id, status: "IN_STOCK" }, select: { serialNumber: true },
    });
    expect(left.map((s) => s.serialNumber)).toEqual(["E-1"]);

    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: p.id, warehouseId } });
    const lots = await prisma.inventoryLot.findMany({ where: { productId: p.id } });
    expect(bal.onHandQty).toBe(1);
    expect(lots.reduce((s, l) => s + l.remainingQty, 0)).toBe(1);
  });

  it("REGRESSION: an anonymous product still adjusts by quantity alone", async () => {
    const p = await prisma.product.create({
      data: { sku: "ADJ-ANON-1", name: "Anon", trackingMode: "NONE" },
    });
    await prisma.$transaction(async (tx) => {
      await createLot(tx, { productId: p.id, warehouseId, quantity: 5, unitCostCents: 1_000, sourceType: "TEST" });
      await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: 5 }, "seed");
    });
    const res = await as(app, token).post("/api/stock-adjustments").send({
      productId: p.id, warehouseId, adjustmentType: "DECREASE", quantity: 2, reason: "water",
    });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: p.id, warehouseId } });
    expect(bal.onHandQty).toBe(3);
  });
});

describe("serialized transfers are refused, for now", () => {
  it("refuses to dispatch a transfer of serial-tracked stock", async () => {
    const p = await serialized("TRF-UT-1", ["F-1"]);
    const created = await as(app, token).post("/api/stock-transfers").send({
      productId: p.id, fromWarehouseId: warehouseId, toWarehouseId: otherWarehouseId, quantity: 1,
    });
    expect([200, 201], JSON.stringify(created.body)).toContain(created.status);

    const res = await as(app, token).post(`/api/stock-transfers/${created.body.id}/start`).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot be transferred/i);
    expect(res.body.details?.action).toBe("serial-transfer-unsupported");

    // The unit must be untouched and still in stock at the source.
    const unit = await prisma.serialUnit.findFirstOrThrow({ where: { productId: p.id } });
    expect(unit.status).toBe("IN_STOCK");
    expect(unit.warehouseId).toBe(warehouseId);
  });
});
