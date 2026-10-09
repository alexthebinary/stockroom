import { allocate, splitAdjustment } from "@pi/domain";
import type { Tx } from "../db";
import { onHandFromLine, revaluePool } from "../stock";

export type LineEffect = { poLineId: number; itemId: number; amountCents: number; inbound: number; onHand: number; cogs: number };

/**
 * Money that lands on a PO line after the fact — a carrier's freight-in bill
 * (positive) or a vendor's price discount (negative). Split by where the
 * line's units are (GAAP guide §I.4, AVCO):
 *   not yet landed  → inventory in transit (they will cost more/less on arrival)
 *   still on hand   → the item's average-cost pool (inventory on hand)
 *   already gone    → Cost of Goods Sold
 * A pool that is empty, or would go below zero, passes the rest to COGS.
 */
export async function applyLineAdjustment(tx: Tx, poLineId: number, amountCents: number): Promise<LineEffect> {
  const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } });
  const expected = Math.max(line.qtyOrdered, line.qtyBilled, line.qtyReceived, 1);
  const landed = Math.min(line.qtyLanded, expected);
  const stillHere = Math.min(await onHandFromLine(tx, poLineId), landed);
  const split = splitAdjustment(amountCents, { lineQty: expected, receivedQty: landed, onHandQty: stillHere });
  let inbound = split.inbound;
  let cogs = split.sold;
  // A discount can't take Inbound below zero for this line; the excess follows the units.
  if (line.inboundCents + inbound < 0) {
    cogs += line.inboundCents + inbound;
    inbound = -line.inboundCents;
  }
  const unabsorbed = await revaluePool(tx, line.itemId, split.onHand);
  const onHand = split.onHand - unabsorbed;
  cogs += unabsorbed;
  await tx.purchaseOrderLine.update({ where: { id: poLineId }, data: { inboundCents: { increment: inbound }, billedCents: { increment: amountCents } } });
  return { poLineId, itemId: line.itemId, amountCents, inbound, onHand, cogs };
}

/** Freight over the target orders' lines, by value (cost of the line) or by quantity. */
export async function freightTargets(tx: Tx, poIds: number[], amountCents: number, basis: "VALUE" | "QTY") {
  const lines = await tx.purchaseOrderLine.findMany({ where: { poId: { in: poIds }, po: { lifecycle: { not: "CANCELED" } } }, orderBy: { id: "asc" } });
  const usable = lines.filter((l) => Math.max(l.qtyOrdered, l.qtyBilled, l.qtyReceived) > 0);
  const value = (l: (typeof usable)[number]) => (l.qtyBilled > 0 ? l.billedCents : Math.max(l.qtyOrdered, l.qtyReceived) * l.unitCostCents);
  const weights = basis === "VALUE" && usable.some((l) => value(l) > 0) ? usable.map(value) : usable.map((l) => Math.max(l.qtyOrdered, l.qtyBilled, l.qtyReceived));
  const parts = usable.length ? allocate(amountCents, weights) : [];
  return usable.map((l, i) => ({ poLineId: l.id, itemId: l.itemId, amountCents: parts[i]! }));
}
