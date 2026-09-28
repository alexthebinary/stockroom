/**
 * The optimistic-concurrency guard on the cost pool.
 *
 * Under FIFO two issues in different warehouses touched different layers and
 * could not collide. Under a company-wide average they share ONE ProductCost
 * row, so the race moved: it is now on the pool, not the lot. The invariant:
 * the pool never goes negative, and its value always tracks its quantity.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { createLot, issueStock } from "../src/costing";

let productId: number;
let a: number;
let b: number;

beforeAll(async () => {
  await boot();
  a = (await prisma.warehouse.create({ data: { name: "Pool A", code: "POOLA" } })).id;
  b = (await prisma.warehouse.create({ data: { name: "Pool B", code: "POOLB" } })).id;
  productId = (await prisma.product.create({ data: { sku: "POOL-RACE", name: "race" } })).id;
  for (const warehouseId of [a, b]) {
    await prisma.$transaction((tx) =>
      createLot(tx, { productId, warehouseId, quantity: 5, unitCostCents: 1_000, sourceType: "TEST", costing: "POOL" })
    );
  }
});

const pull = (warehouseId: number) =>
  prisma.$transaction((tx) =>
    issueStock(tx, { productId, warehouseId, quantity: 1, sourceType: "TEST", context: "race" })
  );

describe("pool optimistic concurrency", () => {
  it("CONTROL: one issue moves the pool", async () => {
    // Without this, the race assertions below could pass because issueStock is
    // broken for everyone.
    await pull(a);
    expect((await prisma.productCost.findUniqueOrThrow({ where: { productId } })).qty).toBe(9);
  });

  it("concurrent issues from two warehouses never overdraw the shared pool", async () => {
    const results = await Promise.allSettled([a, b, a, b].map(pull));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeGreaterThan(0);
    for (const r of results.filter((x) => x.status === "rejected")) {
      const err = (r as PromiseRejectedResult).reason;
      // Same allowance as the FIFO race test: SQLite serialises writers, so a
      // loser may see the committed state (400) rather than lose the version (409).
      expect([400, 409], `unexpected error: ${err?.message}`).toContain(err?.status);
    }
    const pool = await prisma.productCost.findUniqueOrThrow({ where: { productId } });
    const lots = await prisma.inventoryLot.aggregate({ where: { productId }, _sum: { remainingQty: true } });
    expect(pool.qty).toBe(9 - ok);
    expect(lots._sum.remainingQty).toBe(pool.qty);
    expect(pool.valueCents).toBe(pool.qty * 1_000);
  });
});
