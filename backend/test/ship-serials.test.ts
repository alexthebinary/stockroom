/**
 * The ship path, branched on trackingMode.
 *
 * This is the change that could go wrong silently, so it gets a test that
 * asserts the SPECIFIC named units left — not merely that the right count did.
 * A ship that consumes the correct quantity from the wrong serials passes every
 * balance and ledger check and is only discovered during a warranty claim.
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
let customerId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  const wh = await prisma.warehouse.create({ data: { name: "Ship WH", code: "SHWH" } });
  warehouseId = wh.id;
  const c = await prisma.customer.create({ data: { name: "Ship Customer" } });
  customerId = c.id;
});

async function serializedStock(sku: string, serials: string[]) {
  const p = await prisma.product.create({
    data: { sku, name: `S ${sku}`, brand: "Unitree", trackingMode: "SERIAL", defaultPriceCents: 500_000 },
  });
  await prisma.$transaction(async (tx) => {
    await receiveSerials(tx, {
      productId: p.id, warehouseId, unitCostCents: 300_000,
      serials: serials.map((s) => ({ serialNumber: s })), sourceType: "TEST",
    });
    await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: serials.length }, "seed");
  });
  return p;
}

async function anonymousStock(sku: string, qty: number) {
  const p = await prisma.product.create({
    data: { sku, name: `A ${sku}`, trackingMode: "NONE", defaultPriceCents: 10_000 },
  });
  await prisma.$transaction(async (tx) => {
    await createLot(tx, { productId: p.id, warehouseId, quantity: qty, unitCostCents: 4_000, sourceType: "TEST" });
    await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: qty }, "seed");
  });
  return p;
}

/** Create → pack → (caller ships). Returns the order with its line ids. */
async function packedOrder(productId: number, quantity: number) {
  const created = await as(app, token)
    .post("/api/sales-orders")
    .send({ customerId, lines: [{ productId, warehouseId, quantity }] });
  expect([200, 201], JSON.stringify(created.body)).toContain(created.status);
  const packed = await as(app, token).post(`/api/sales-orders/${created.body.id}/pack`).send({});
  expect([200, 201], JSON.stringify(packed.body)).toContain(packed.status);
  const full = await as(app, token).get(`/api/sales-orders/${created.body.id}`);
  return full.body;
}

describe("shipping a serial-tracked line", () => {
  it("refuses to ship without naming the units", async () => {
    const p = await serializedStock("SHIP-UT-1", ["S-A", "S-B"]);
    const order = await packedOrder(p.id, 1);

    const res = await as(app, token).post(`/api/sales-orders/${order.id}/ship`).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/serial-tracked/i);
    // The refusal must tell the UI what to do, not just say no.
    expect(res.body.details?.action).toBe("scan-serials");

    // Nothing may have moved.
    const inStock = await prisma.serialUnit.count({ where: { productId: p.id, status: "IN_STOCK" } });
    expect(inStock).toBe(2);
  });

  it("refuses a serial count that does not match the line quantity", async () => {
    const p = await serializedStock("SHIP-UT-2", ["T-A", "T-B", "T-C"]);
    const order = await packedOrder(p.id, 2);
    const line = order.lines[0];

    const res = await as(app, token)
      .post(`/api/sales-orders/${order.id}/ship`)
      .send({ serials: [{ lineId: line.id, serialNumbers: ["T-A"] }] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/1 serial\(s\) named for a line of 2/i);
  });

  it("ships exactly the NAMED units, not the oldest ones", async () => {
    // The assertion that matters. Receipt order is U-1, U-2, U-3; we ship U-3.
    const p = await serializedStock("SHIP-UT-3", ["U-1", "U-2", "U-3"]);
    const order = await packedOrder(p.id, 1);
    const line = order.lines[0];

    const res = await as(app, token)
      .post(`/api/sales-orders/${order.id}/ship`)
      .send({ serials: [{ lineId: line.id, serialNumbers: ["U-3"] }] });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    const sold = await prisma.serialUnit.findMany({
      where: { productId: p.id, status: "SOLD" },
      select: { serialNumber: true },
    });
    expect(sold.map((s) => s.serialNumber)).toEqual(["U-3"]);

    const left = await prisma.serialUnit.findMany({
      where: { productId: p.id, status: "IN_STOCK" },
      select: { serialNumber: true },
    });
    expect(left.map((s) => s.serialNumber).sort()).toEqual(["U-1", "U-2"]);

    // Balance and layers still agree with the serials.
    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: p.id, warehouseId } });
    const lots = await prisma.inventoryLot.findMany({ where: { productId: p.id } });
    expect(bal.onHandQty).toBe(2);
    expect(lots.reduce((s, l) => s + l.remainingQty, 0)).toBe(2);
  });

  it("REGRESSION: an anonymous product still ships through consumeFifo untouched", async () => {
    // The branch must not change behaviour for non-serialized stock.
    const p = await anonymousStock("SHIP-ANON-1", 5);
    const order = await packedOrder(p.id, 2);

    const res = await as(app, token).post(`/api/sales-orders/${order.id}/ship`).send({});
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: p.id, warehouseId } });
    expect(bal.onHandQty).toBe(3);
  });
});
