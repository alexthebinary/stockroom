/**
 * FIFO consumes the OLDEST layer, not the newest or the cheapest.
 *
 * Written after an end-to-end run asserted the wrong thing: it received stock
 * at a new cost, shipped, and expected COGS at that NEW cost. The app booked
 * the older seeded layer instead and was correct. The assertion was wrong, and
 * nothing in the suite would have caught the inverse mistake — a regression
 * that consumed newest-first would have kept every existing test green,
 * because no test held two layers at different costs.
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
  warehouseId = (await prisma.warehouse.create({ data: { name: "FIFO WH", code: "FIFOWH" } })).id;
});

/**
 * Two layers at different costs, the cheaper one OLDER. Deliberately not
 * ascending by id alone: `receivedAt` is the ordering the code must honour.
 */
async function twoLayers(sku: string, oldCost: number, newCost: number) {
  const product = await prisma.product.create({
    data: { sku, name: `FIFO ${sku}`, brand: "Unitree", defaultPriceCents: 500_000 },
  });
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-06-01T00:00:00Z");

  await prisma.$transaction(async (tx) => {
    await createLot(tx, {
      productId: product.id, warehouseId, quantity: 5,
      unitCostCents: oldCost, receivedAt: older, sourceType: "TEST",
    });
    await createLot(tx, {
      productId: product.id, warehouseId, quantity: 5,
      unitCostCents: newCost, receivedAt: newer, sourceType: "TEST",
    });
    await applyBalanceDelta(tx, product.id, warehouseId, { onHandQty: 10 }, "seed");
  });
  return product.id;
}

async function shipTwo(productId: number) {
  const api = as(app, token);
  const customer = await prisma.customer.create({ data: { name: `FIFO buyer ${productId}` } });
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

describe("FIFO layer order", () => {
  it("books COGS at the OLDER layer when the older one is cheaper", async () => {
    const productId = await twoLayers("FIFO-CHEAP-OLD", 123_500, 125_000);
    expect(await shipTwo(productId)).toBe(2 * 123_500);
  });

  it("books COGS at the OLDER layer when the older one is DEARER", async () => {
    // The case that separates "first in" from "cheapest". A cheapest-first
    // implementation passes the test above and fails this one.
    const productId = await twoLayers("FIFO-DEAR-OLD", 200_000, 100_000);
    expect(await shipTwo(productId)).toBe(2 * 200_000);
  });

  it("spans two layers when one cannot cover the quantity", async () => {
    const productId = await twoLayers("FIFO-SPAN", 100_000, 300_000);
    const api = as(app, token);
    const customer = await prisma.customer.create({ data: { name: "FIFO spanner" } });
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
    // All 5 of the old layer, then 2 of the new.
    expect(detail.body.shipments[0].cogsCents).toBe(5 * 100_000 + 2 * 300_000);
  });

  it("leaves the newer layer untouched while the older one still covers demand", async () => {
    const productId = await twoLayers("FIFO-REMAIN", 111_000, 222_000);
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
