/**
 * Perpetual weighted average cost (2026-09-28, client approved; replaces FIFO).
 *
 * One running average per product across every warehouse. A receipt adds its
 * value and re-averages; an issue is costed at round(value × q / qty), and the
 * last units out take whatever value is left so the pool drains to exactly 0.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { allocate, createLot, ensureCostPool, issueStock, shareOfPool } from "../src/costing";
import { consumeSerials, receiveSerials } from "../src/serials";

let wh: number;
let wh2: number;

beforeAll(async () => {
  await boot();
  wh = (await prisma.warehouse.create({ data: { name: "WAC A", code: "WACA" } })).id;
  wh2 = (await prisma.warehouse.create({ data: { name: "WAC B", code: "WACB" } })).id;
});

const product = (sku: string) => prisma.product.create({ data: { sku, name: sku } });
const pool = (productId: number) => prisma.productCost.findUniqueOrThrow({ where: { productId } });
const receive = (productId: number, warehouseId: number, quantity: number, unitCostCents: number) =>
  prisma.$transaction((tx) =>
    createLot(tx, { productId, warehouseId, quantity, unitCostCents, sourceType: "TEST", costing: "POOL" })
  );
const issue = (productId: number, warehouseId: number, quantity: number) =>
  prisma.$transaction((tx) =>
    issueStock(tx, { productId, warehouseId, quantity, sourceType: "TEST", context: "test" })
  );

describe("allocate / shareOfPool", () => {
  it("allocate sums exactly to the total", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([333, 334, 333]);
    expect(allocate(1000, [1, 1, 1]).reduce((a, b) => a + b)).toBe(1000);
    expect(allocate(701, [5, 2])).toEqual([501, 200]);
  });

  it("the last units take the remaining value", () => {
    expect(shareOfPool({ qty: 3, valueCents: 1000 }, 3)).toBe(1000);
    expect(shareOfPool({ qty: 3, valueCents: 1000 }, 1)).toBe(333);
  });
});

describe("weighted average cost", () => {
  it("averages two receipts at different costs and issues at the average", async () => {
    const p = await product("WAC-AVG");
    await receive(p.id, wh, 5, 100_000);
    await receive(p.id, wh, 5, 300_000);
    const out = await issue(p.id, wh, 2);
    // 2 × 200_000. FIFO would have booked 2 × 100_000.
    expect(out.totalCostCents).toBe(400_000);
    expect(await pool(p.id)).toMatchObject({ qty: 8, valueCents: 1_600_000 });
  });

  it("re-averages after a receipt that follows an issue", async () => {
    const p = await product("WAC-MOVING");
    await receive(p.id, wh, 4, 1_000); // avg 1000
    await issue(p.id, wh, 2); // 2 left worth 2000
    await receive(p.id, wh, 2, 4_000); // 4 worth 10_000 → avg 2500
    expect((await issue(p.id, wh, 1)).totalCostCents).toBe(2_500);
  });

  it("drains to exactly zero value on a fractional average", async () => {
    const p = await product("WAC-DRAIN");
    await receive(p.id, wh, 3, 0);
    await prisma.productCost.update({ where: { productId: p.id }, data: { valueCents: 1000 } });
    const costs: number[] = [];
    for (let i = 0; i < 3; i++) costs.push((await issue(p.id, wh, 1)).totalCostCents);
    expect(costs.reduce((a, b) => a + b)).toBe(1000);
    expect(await pool(p.id)).toMatchObject({ qty: 0, valueCents: 0 });
  });

  it("one average spans warehouses", async () => {
    const p = await product("WAC-2WH");
    await receive(p.id, wh, 1, 1_000);
    await receive(p.id, wh2, 1, 3_000);
    expect((await issue(p.id, wh, 1)).totalCostCents).toBe(2_000);
  });

  it("first receipt of a new product is not double counted", async () => {
    const p = await product("WAC-FIRST");
    await receive(p.id, wh, 10, 500);
    expect(await pool(p.id)).toMatchObject({ qty: 10, valueCents: 5_000 });
  });

  it("opening pool comes from open layers created before the pool existed", async () => {
    const p = await product("WAC-CUTOVER");
    // Legacy FIFO layers: created without touching any pool.
    await prisma.$transaction(async (tx) => {
      await createLot(tx, { productId: p.id, warehouseId: wh, quantity: 2, unitCostCents: 100, sourceType: "TEST", costing: "CARRY" });
      await createLot(tx, { productId: p.id, warehouseId: wh2, quantity: 1, unitCostCents: 400, sourceType: "TEST", costing: "CARRY" });
    });
    expect(await prisma.productCost.findUnique({ where: { productId: p.id } })).toBeNull();
    const opened = await prisma.$transaction((tx) => ensureCostPool(tx, p.id));
    expect(opened).toMatchObject({ qty: 3, valueCents: 600 });
    const again = await prisma.$transaction((tx) => ensureCostPool(tx, p.id));
    expect(again.valueCents).toBe(600);
  });

  it("an issue that opens the pool counts the units it draws once", async () => {
    const p = await product("WAC-LAZY-ISSUE");
    await prisma.$transaction((tx) =>
      createLot(tx, { productId: p.id, warehouseId: wh, quantity: 4, unitCostCents: 250, sourceType: "TEST", costing: "CARRY" })
    );
    // No pool yet (legacy stock). The issue itself triggers the cutover.
    expect((await issue(p.id, wh, 1)).totalCostCents).toBe(250);
    expect(await pool(p.id)).toMatchObject({ qty: 3, valueCents: 750 });
  });

  it("serials are costed at the average, and a serial issue that opens the pool counts once", async () => {
    const p = await prisma.product.create({ data: { sku: "WAC-SER", name: "ser", trackingMode: "SERIAL" } });
    // Two legacy units at different receipt costs, no pool yet.
    await prisma.$transaction(async (tx) => {
      for (const [serialNumber, cost] of [["WS-1", 1_000], ["WS-2", 3_000]] as const) {
        const lot = await createLot(tx, {
          productId: p.id, warehouseId: wh, quantity: 1, unitCostCents: cost, sourceType: "TEST", costing: "CARRY",
        });
        await receiveSerials(tx, {
          productId: p.id, warehouseId: wh, unitCostCents: cost, serials: [{ serialNumber }],
          sourceType: "TEST", lotId: lot.id,
        });
      }
    });
    const out = await prisma.$transaction((tx) =>
      consumeSerials(tx, { productId: p.id, warehouseId: wh, serialNumbers: ["WS-1"], sourceType: "TEST", context: "t" })
    );
    // WS-1 was received at 1_000, but the pool's average is 2_000.
    expect(out.totalCostCents).toBe(2_000);
    expect(await pool(p.id)).toMatchObject({ qty: 1, valueCents: 2_000 });
  });

  it("slices of one issue sum to its total", async () => {
    const p = await product("WAC-SLICES");
    await receive(p.id, wh, 1, 100);
    await receive(p.id, wh, 1, 201);
    const out = await issue(p.id, wh, 2);
    const rows = await prisma.lotConsumption.findMany({ where: { id: { in: out.consumptionIds } } });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.costCents, 0)).toBe(out.totalCostCents);
    expect(out.slices.reduce((s, r) => s + r.costCents, 0)).toBe(out.totalCostCents);
  });

  it("refuses to issue more than the warehouse holds", async () => {
    const p = await product("WAC-SHORT");
    await receive(p.id, wh, 1, 100);
    await receive(p.id, wh2, 5, 100);
    // The pool holds 6, but this warehouse only 1: the physical check wins.
    await expect(issue(p.id, wh, 2)).rejects.toMatchObject({ status: 400 });
    expect(await pool(p.id)).toMatchObject({ qty: 6, valueCents: 600 });
  });
});
