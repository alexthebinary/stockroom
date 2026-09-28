/**
 * Whole-system invariants of weighted average costing, after real HTTP flows:
 *
 *   Σ ProductCost.qty   == Σ open lot remainingQty + Σ IN_TRANSIT transfer qty
 *   Σ ProductCost.value == the Inventory accounts on the ledger (variance 0)
 *
 * The first catches a flow that moves lots without the pool (or twice); the
 * second catches one whose journal entry used a different number than the pool.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { ensureCostPools } from "../src/costing";
import { inventoryValuation } from "../src/books";

let app: Express;
let token: string;
let a: number;
let b: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  a = (await prisma.warehouse.create({ data: { name: "Inv A", code: "INVA" } })).id;
  b = (await prisma.warehouse.create({ data: { name: "Inv B", code: "INVB" } })).id;
});

async function assertInvariants() {
  await ensureCostPools();
  const [pools, lots, transfers] = await Promise.all([
    prisma.productCost.findMany(),
    prisma.inventoryLot.aggregate({ _sum: { remainingQty: true } }),
    prisma.stockTransfer.aggregate({ where: { status: "IN_TRANSIT" }, _sum: { quantity: true } }),
  ]);
  expect(pools.reduce((s, p) => s + p.qty, 0), "pool qty vs lots + in transit").toBe(
    (lots._sum.remainingQty ?? 0) + (transfers._sum.quantity ?? 0)
  );
  const v = await inventoryValuation();
  expect(v.assetValueCents, "valuation reads the pools").toBe(pools.reduce((s, p) => s + p.valueCents, 0));
  expect(v.varianceCents, "pool value vs ledger").toBe(0);
}

async function ok(res: { status: number; body: unknown }) {
  if (res.status >= 300) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: number };
}

describe("cost invariants", () => {
  it("hold across adjust-in, transfer start/complete, adjust-out", async () => {
    const api = as(app, token);
    const p = await ok(await api.post("/api/products").send({ sku: "INV-1", name: "Inv", costOfGoodsCents: 1_000 }));
    const adjust = (adjustmentType: string, quantity: number, unitCostCents?: number) =>
      api.post("/api/stock-adjustments").send({
        productId: p.id, warehouseId: a, adjustmentType, quantity, reason: "test", unitCostCents,
      });

    await ok(await adjust("INCREASE", 4, 1_000));
    await ok(await adjust("INCREASE", 4, 2_000));
    await assertInvariants();

    const t = await ok(await api.post("/api/stock-transfers").send({
      productId: p.id, fromWarehouseId: a, toWarehouseId: b, quantity: 2,
    }));
    await ok(await api.post(`/api/stock-transfers/${t.id}/start`));
    await assertInvariants();
    await ok(await api.post(`/api/stock-transfers/${t.id}/complete`));
    await assertInvariants();
    // A transfer moves no value: still 8 units worth 12_000.
    expect(await prisma.productCost.findUniqueOrThrow({ where: { productId: p.id } }))
      .toMatchObject({ qty: 8, valueCents: 12_000 });

    await ok(await adjust("DECREASE", 1));
    await assertInvariants();
    expect(await prisma.productCost.findUniqueOrThrow({ where: { productId: p.id } }))
      .toMatchObject({ qty: 7, valueCents: 10_500 });
  });

  it("a never-moved product with a boot-opened pool can still be hard-deleted", async () => {
    const api = as(app, token);
    const p = await ok(await api.post("/api/products").send({ sku: "INV-DEL", name: "del" }));
    await ensureCostPools(); // what every boot does
    const res = await api.delete(`/api/products/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, soft: false });
  });

  describe("stock arriving with no price", () => {
    const adjustIn = (productId: number, quantity: number, unitCostCents?: number) =>
      as(app, token).post("/api/stock-adjustments").send({
        productId, warehouseId: a, adjustmentType: "INCREASE", quantity, reason: "test", unitCostCents,
      });
    const countUp = async (productId: number, countedQty: number) => {
      const api = as(app, token);
      const opened = await ok(await api.post("/api/stock-counts").send({ warehouseId: a, productIds: [productId] }));
      await ok(await api.post(`/api/stock-counts/${opened.id}/lines`).send({ lines: [{ productId, countedQty }] }));
      await ok(await api.post(`/api/stock-counts/${opened.id}/post`));
    };
    const poolOf = (productId: number) => prisma.productCost.findUniqueOrThrow({ where: { productId } });

    it("adjust-in comes in at the product's total cost when the pool is empty, then at the average", async () => {
      const api = as(app, token);
      const p = await ok(await api.post("/api/products").send({
        sku: "INV-DEF", name: "def", costOfGoodsCents: 700, supplierShippingCents: 300,
      }));
      await ok(await adjustIn(p.id, 1)); // empty pool → 1000 (total), not 700 (goods only), not 0
      expect(await poolOf(p.id)).toMatchObject({ qty: 1, valueCents: 1_000 });
      await ok(await adjustIn(p.id, 1, 3_000)); // avg 2000
      await ok(await adjustIn(p.id, 1)); // at the average
      expect(await poolOf(p.id)).toMatchObject({ qty: 3, valueCents: 6_000 });
      await assertInvariants();
    });

    it("a count gain comes in at the current average", async () => {
      const api = as(app, token);
      const p = await ok(await api.post("/api/products").send({ sku: "INV-CNT", name: "cnt", costOfGoodsCents: 999 }));
      await ok(await adjustIn(p.id, 1, 1_000));
      await ok(await adjustIn(p.id, 1, 3_000)); // 2 units, avg 2000
      await countUp(p.id, 3); // found one
      expect(await poolOf(p.id)).toMatchObject({ qty: 3, valueCents: 6_000 });
      await assertInvariants();
    });

    it("a count gain on a product with no cost at all still lands in the pool (at zero)", async () => {
      const api = as(app, token);
      const p = await ok(await api.post("/api/products").send({ sku: "INV-ZERO", name: "zero" }));
      await ok(await adjustIn(p.id, 1, 0)); // stocked, but worth nothing
      await countUp(p.id, 3);
      expect(await poolOf(p.id)).toMatchObject({ qty: 3, valueCents: 0 });
      await assertInvariants();
    });
  });
});
