import { refuse } from "./errors";
import { assertCents, type Cents } from "./money";

/**
 * Average cost (AVCO), GAAP guide §I.3: one pool per item holds the units on
 * hand and their total value. A receipt adds both; an issue takes its share of
 * the value at the average; the last unit out takes whatever value is left, so
 * the pool drains to exactly zero and never strands a rounding cent.
 *
 * The pool's VALUE is the item's slice of inventory on hand (Inventory Asset, on-hand lines).
 */
export type Pool = { qty: number; valueCents: Cents };

export const emptyPool = (): Pool => ({ qty: 0, valueCents: 0 });

/** Unrounded average, in cents. Display it; never post it. */
export function averageUnitCost(pool: Pool): number {
  return pool.qty === 0 ? 0 : pool.valueCents / pool.qty;
}

export function receive(pool: Pool, qty: number, valueCents: Cents): Pool {
  if (!Number.isInteger(qty) || qty <= 0) throw refuse("a receipt needs a positive whole quantity");
  assertCents(valueCents, "receipt value");
  if (valueCents < 0) throw refuse("a receipt cannot carry a negative value");
  return { qty: pool.qty + qty, valueCents: pool.valueCents + valueCents };
}

export function issueCost(pool: Pool, qty: number): Cents {
  if (!Number.isInteger(qty) || qty <= 0) throw refuse("an issue needs a positive whole quantity");
  if (qty > pool.qty) throw refuse(`only ${pool.qty} unit(s) are on hand and costed, ${qty} requested`);
  return qty === pool.qty ? pool.valueCents : Math.round((pool.valueCents * qty) / pool.qty);
}

export function issue(pool: Pool, qty: number): { pool: Pool; costCents: Cents } {
  const costCents = issueCost(pool, qty);
  return { pool: { qty: pool.qty - qty, valueCents: pool.valueCents - costCents }, costCents };
}

/** Change the value of the units on hand (freight or a discount that arrives later). */
export function revalue(pool: Pool, deltaCents: Cents): Pool {
  assertCents(deltaCents, "revaluation");
  if (pool.qty === 0) throw refuse("there are no units on hand to carry a revaluation");
  const valueCents = pool.valueCents + deltaCents;
  if (valueCents < 0) throw refuse("a revaluation cannot take stock value below zero");
  return { qty: pool.qty, valueCents };
}
