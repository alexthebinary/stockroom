import { DomainError, issueCost } from "@pi/domain";
import type { Tx } from "./db";

/**
 * THE ONLY MODULE THAT CHANGES STOCK. Balances, the average-cost pool, the
 * physical lot trail and the unit registers (WH-IN / WH-OUT / ADJ) move
 * together here or not at all, which is what lets the books-sound check prove
 * them against each other.
 *
 * Concurrency: balance changes are single atomic UPDATEs guarded by their own
 * arithmetic (never a read-then-write); the pool and lots are row-locked
 * (SELECT … FOR UPDATE) for the length of the transaction, so two people
 * issuing the same item queue up instead of averaging stale numbers.
 */
export type StockCtx = { tx: Tx; actor: string };

type Register = "WH_IN" | "WH_OUT" | "ADJ";
type Bucket = "ON_HAND" | "HELD";
export type Counter = { type: "BILL" | "PO" | "VENDOR_CREDIT" | "OPENING"; id: number };

async function ensureRows(tx: Tx, itemId: number, warehouseId: number) {
  await tx.$executeRaw`INSERT INTO "StockBalance" ("itemId", "warehouseId") VALUES (${itemId}, ${warehouseId}) ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`INSERT INTO "CostPool" ("itemId") VALUES (${itemId}) ON CONFLICT DO NOTHING`;
}

async function bump(tx: Tx, itemId: number, warehouseId: number, onHand: number, held: number) {
  const changed = await tx.$executeRaw`
    UPDATE "StockBalance"
       SET "onHand" = "onHand" + ${onHand}, "held" = "held" + ${held}, "version" = "version" + 1
     WHERE "itemId" = ${itemId} AND "warehouseId" = ${warehouseId}
       AND "onHand" + ${onHand} >= "reserved" AND "held" + ${held} >= 0`;
  if (changed === 0) {
    const what = onHand < 0 ? `${-onHand} unit(s) on hand` : `${-held} held unit(s)`;
    throw new DomainError(`Not enough stock: this needs ${what} of item ${itemId} at warehouse ${warehouseId}`, 400);
  }
}

async function record(
  ctx: StockCtx,
  m: { register: Register; docNumber: string; itemId: number; warehouseId: number; bucket: Bucket; qtyDelta: number; counter: Counter; valueCents?: number },
) {
  await ctx.tx.stockMovement.create({
    data: {
      register: m.register,
      docNumber: m.docNumber,
      itemId: m.itemId,
      warehouseId: m.warehouseId,
      bucket: m.bucket,
      qtyDelta: m.qtyDelta,
      counterType: m.counter.type,
      counterId: m.counter.id,
      valueCents: m.valueCents,
      actor: ctx.actor,
    },
  });
}

/** Units arrived at the dock with no posted bill: counted, not available, not valued. */
export async function holdUnits(ctx: StockCtx, input: { itemId: number; warehouseId: number; qty: number; docNumber: string; poId: number }) {
  await ensureRows(ctx.tx, input.itemId, input.warehouseId);
  await bump(ctx.tx, input.itemId, input.warehouseId, 0, input.qty);
  await record(ctx, { register: "WH_IN", bucket: "HELD", qtyDelta: input.qty, counter: { type: "PO", id: input.poId }, ...input });
}

/** Held units that will not be kept (rejected at the dock, or a voided bill sends landed units back). */
export async function releaseHeld(ctx: StockCtx, input: { itemId: number; warehouseId: number; qty: number; docNumber: string; counter: Counter }) {
  await bump(ctx.tx, input.itemId, input.warehouseId, 0, -input.qty);
  await record(ctx, { register: "WH_IN", bucket: "HELD", qtyDelta: -input.qty, ...input });
}

/**
 * Units become owned stock against a bill (or opening balance): on hand goes
 * up, their value joins the item's average, and a lot records where they came
 * from. With fromHeld, they leave the held bucket in the same breath.
 */
export async function landUnits(
  ctx: StockCtx,
  input: {
    itemId: number;
    warehouseId: number;
    qty: number;
    valueCents: number;
    fromHeld: boolean;
    docNumber: string;
    counter: Counter;
    register?: Register;
    poLineId?: number;
    receiptLineId?: number;
  },
) {
  const { tx } = ctx;
  if (input.qty <= 0) throw new DomainError("Landing needs a positive quantity", 400);
  if (input.valueCents < 0) throw new DomainError("Landed value cannot be negative", 400);
  await ensureRows(tx, input.itemId, input.warehouseId);
  if (input.fromHeld) {
    await bump(tx, input.itemId, input.warehouseId, 0, -input.qty);
    await record(ctx, { register: "WH_IN", bucket: "HELD", qtyDelta: -input.qty, ...input });
  }
  await bump(tx, input.itemId, input.warehouseId, input.qty, 0);
  await record(ctx, { register: input.register ?? "WH_IN", bucket: "ON_HAND", qtyDelta: input.qty, ...input });
  await tx.$executeRaw`
    UPDATE "CostPool" SET "qty" = "qty" + ${input.qty}, "valueCents" = "valueCents" + ${input.valueCents}, "version" = "version" + 1
     WHERE "itemId" = ${input.itemId}`;
  return tx.inventoryLot.create({
    data: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      poLineId: input.poLineId,
      receiptLineId: input.receiptLineId,
      sourceType: input.counter.type,
      sourceId: input.counter.id,
      qtyIn: input.qty,
      qtyRemaining: input.qty,
    },
  });
}

async function lockPool(tx: Tx, itemId: number) {
  await tx.$executeRaw`INSERT INTO "CostPool" ("itemId") VALUES (${itemId}) ON CONFLICT DO NOTHING`;
  const [pool] = await tx.$queryRaw<{ qty: number; valueCents: number }[]>`
    SELECT "qty", "valueCents" FROM "CostPool" WHERE "itemId" = ${itemId} FOR UPDATE`;
  return pool!;
}

/**
 * Units leave owned stock at the item's average cost (WH-OUT). Lots are drawn
 * oldest-first — from `preferPoLineId`'s lots first when the units going out
 * are known to be that line's (a return to the vendor). Returns their cost.
 */
export async function issueUnits(
  ctx: StockCtx,
  input: { itemId: number; warehouseId: number; qty: number; docNumber: string; counter: Counter; preferPoLineId?: number },
): Promise<number> {
  const { tx } = ctx;
  const pool = await lockPool(tx, input.itemId);
  const costCents = issueCost(pool, input.qty);
  await bump(tx, input.itemId, input.warehouseId, -input.qty, 0);
  await tx.$executeRaw`
    UPDATE "CostPool" SET "qty" = "qty" - ${input.qty}, "valueCents" = "valueCents" - ${costCents}, "version" = "version" + 1
     WHERE "itemId" = ${input.itemId}`;
  const lots = await tx.$queryRaw<{ id: number; qtyRemaining: number }[]>`
    SELECT "id", "qtyRemaining" FROM "InventoryLot"
     WHERE "itemId" = ${input.itemId} AND "warehouseId" = ${input.warehouseId} AND "qtyRemaining" > 0
     ORDER BY ("poLineId" IS NOT DISTINCT FROM ${input.preferPoLineId ?? null}::int) DESC, "id"
     FOR UPDATE`;
  let left = input.qty;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.qtyRemaining);
    await tx.inventoryLot.update({ where: { id: lot.id }, data: { qtyRemaining: { decrement: take } } });
    left -= take;
  }
  if (left > 0) throw new DomainError(`The lot trail for item ${input.itemId} is short by ${left}; run the books check`, 409);
  await record(ctx, { register: "WH_OUT", bucket: "ON_HAND", qtyDelta: -input.qty, valueCents: costCents, ...input });
  return costCents;
}

/**
 * Change the value of an item's units on hand (late freight or a discount).
 * Returns what could not be absorbed: if the pool is empty, or a decrease
 * would take it below zero, the caller books the remainder to COGS.
 */
export async function revaluePool(tx: Tx, itemId: number, deltaCents: number): Promise<number> {
  if (deltaCents === 0) return 0;
  const pool = await lockPool(tx, itemId);
  if (pool.qty === 0) return deltaCents;
  const applied = Math.max(deltaCents, -pool.valueCents);
  await tx.$executeRaw`
    UPDATE "CostPool" SET "valueCents" = "valueCents" + ${applied}, "version" = "version" + 1 WHERE "itemId" = ${itemId}`;
  return deltaCents - applied;
}

/** How many of a PO line's landed units are still on the shelf (for the freight split). */
export async function onHandFromLine(tx: Tx, poLineId: number): Promise<number> {
  const result = await tx.inventoryLot.aggregate({ where: { poLineId }, _sum: { qtyRemaining: true } });
  return result._sum.qtyRemaining ?? 0;
}
