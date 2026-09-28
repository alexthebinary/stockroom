/**
 * Shipping over HTTP books COGS at the weighted average, while the units are
 * still PICKED oldest receipt first.
 *
 * Was fifo-layer-order.test.ts. Under FIFO the older layer's cost was the COGS;
 * since the 2026-09-28 switch the cost is the average of every unit in the
 * pool, and layer order only decides which physical receipt is drawn down.
 * Two layers at different costs are what separate the two rules.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { createLot } from "../src/costing";
import { applyBalanceDelta } from "../src/inventory";

let app: Express;
let token: string;
let warehouseId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Pick WH", code: "PICKWH" } })).id;
});

/**
 * Two layers at different costs, the cheaper one OLDER. Deliberately not
 * ascending by id alone: `receivedAt` is the ordering the code must honour.
 */
async function twoLayers(sku: string, oldCost: number, newCost: number) {
  const product = await prisma.product.create({
    data: { sku, name: `WAC ${sku}`, brand: "Unitree", defaultPriceCents: 500_000 },
  });
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-06-01T00:00:00Z");

  await prisma.$transaction(async (tx) => {
    await createLot(tx, {
      productId: product.id, warehouseId, quantity: 5,
      unitCostCents: oldCost, receivedAt: older, sourceType: "TEST", costing: "POOL",
    });
    await createLot(tx, {
      productId: product.id, warehouseId, quantity: 5,
      unitCostCents: newCost, receivedAt: newer, sourceType: "TEST", costing: "POOL",
    });
    await applyBalanceDelta(tx, product.id, warehouseId, { onHandQty: 10 }, "seed");
  });
  return product.id;
}

async function shipTwo(productId: number) {
  const api = as(app, token);
  const customer = await prisma.customer.create({ data: { name: `WAC buyer ${productId}` } });
  const created = await api.post("/api/sales-orders").send({
    customerId: customer.id,
    lines: [{ productId, warehouseId, quantity: 2, unitPriceCents: 500_000 }],
  });
  expect(created.status).toBe(201);
  const id = created.body.id as number;
  for (const verb of ["pack", "invoice", "pay", "ship"]) {
    const res = await api.post(`/api/sales-orders/${id}/${verb}`);
    if (res.status >= 300) throw new Error(`${verb} failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const detail = await api.get(`/api/sales-orders/${id}`);
  return detail.body.shipments[0].cogsCents as number;
}

describe("weighted average COGS, oldest-first picking", () => {
  it("books COGS at the average, not the older layer's cost", async () => {
    // FIFO would book 2 × 123_500; cheapest-first the same. Average: 124_250.
    const productId = await twoLayers("WAC-CHEAP-OLD", 123_500, 125_000);
    expect(await shipTwo(productId)).toBe(2 * 124_250);
  });

  it("books the same average when the older layer is DEARER", async () => {
    const productId = await twoLayers("WAC-DEAR-OLD", 200_000, 100_000);
    expect(await shipTwo(productId)).toBe(2 * 150_000);
  });

  it("a shipment spanning both layers is still costed at the average", async () => {
    const productId = await twoLayers("WAC-SPAN", 100_000, 300_000);
    const api = as(app, token);
    const customer = await prisma.customer.create({ data: { name: "WAC spanner" } });
    const created = await api.post("/api/sales-orders").send({
      customerId: customer.id,
      lines: [{ productId, warehouseId, quantity: 7, unitPriceCents: 500_000 }],
    });
    const id = created.body.id as number;
    for (const verb of ["pack", "invoice", "pay", "ship"]) {
      const res = await api.post(`/api/sales-orders/${id}/${verb}`);
      if (res.status >= 300) throw new Error(`${verb} failed: ${JSON.stringify(res.body)}`);
    }
    const detail = await api.get(`/api/sales-orders/${id}`);
    expect(detail.body.shipments[0].cogsCents).toBe(7 * 200_000);
  });

  it("draws the OLDER receipt first while it still covers demand", async () => {
    const productId = await twoLayers("WAC-REMAIN", 111_000, 222_000);
    await shipTwo(productId);
    const lots = await prisma.inventoryLot.findMany({
      where: { productId }, orderBy: { receivedAt: "asc" },
    });
    expect(lots.map((l) => [l.unitCostCents, l.remainingQty])).toEqual([
      [111_000, 3], // 5 - 2
      [222_000, 5], // untouched
    ]);
  });
});
