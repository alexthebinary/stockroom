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
export async function applyLineAdjustment(tx: Tx, poLineId: number, amountCents: number, billLineId?: number): Promise<LineEffect> {
  const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } });
  const owned = billLineId ? await billLineStock(tx, billLineId) : null;
  const expected = owned ? Math.max(owned.remaining, 1) : Math.max(line.qtyOrdered, line.qtyBilled, line.qtyReceived, 1);
  const landed = Math.min(owned ? owned.landed : line.qtyLanded, expected);
  const stillHere = Math.min(owned ? owned.onHand : await onHandFromLine(tx, poLineId), landed);
  const split = splitAdjustment(amountCents, { lineQty: expected, receivedQty: landed, onHandQty: stillHere });
  let inbound = split.inbound;
  let cogs = split.sold;
  // A discount can't take Inbound below zero for this line; the excess follows the units.
  if (line.inboundCents + inbound < 0) {
    cogs += line.inboundCents + inbound;
    inbound = -line.inboundCents;
  }
  if (billLineId) {
    const billLine = await tx.vendorBillLine.findUniqueOrThrow({ where: { id: billLineId } });
    if (billLine.inboundCents + inbound < 0) {
      cogs += billLine.inboundCents + inbound;
      inbound = -billLine.inboundCents;
    }
    await tx.vendorBillLine.update({ where: { id: billLineId }, data: { inboundCents: { increment: inbound } } });
  } else if (inbound !== 0) {
    const targets = await pendingBillLines(tx, poLineId);
    if (targets.length) {
      // Freight also covers ordered units that have not been billed yet.
      // Leave their share on the PO until their bill posts.
      const unownedQty = Math.max(0, expected - landed - targets.reduce((n,t) => n + t.pending, 0));
      const unownedValue = Math.max(0, line.inboundCents - targets.reduce((n,t) => n + t.inboundCents, 0));
      const weights = [...targets.map(t => inbound < 0 ? t.inboundCents : t.pending), inbound < 0 ? unownedValue : unownedQty];
      const parts = allocate(Math.abs(inbound), weights);
      for (const [i, target] of targets.entries()) await tx.vendorBillLine.update({ where: { id: target.id }, data: { inboundCents: { increment: Math.sign(inbound) * parts[i]! } } });
    }
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

/** Historical landings and returns belong to a bill line, never the whole PO. */
export async function billLineStock(tx: Tx, billLineId: number) {
  const line = await tx.vendorBillLine.findUniqueOrThrow({ where: { id: billLineId } });
  const lots = await tx.inventoryLot.aggregate({ where: { billLineId }, _sum: { qtyIn: true, qtyRemaining: true } });
  const credits = await tx.vendorCreditLine.findMany({ where: { billLineId } });
  const returned = credits.reduce((n,c) => n + c.qty, 0);
  const returnedReceived = credits.filter(c => c.received).reduce((n,c) => n + c.qty, 0);
  const landedEver = lots._sum.qtyIn ?? 0;
  return {
    remaining: line.qty - returned,
    landed: landedEver - returnedReceived,
    pending: line.qty - landedEver - (returned - returnedReceived),
    onHand: lots._sum.qtyRemaining ?? 0,
    credited: credits.reduce((n,c) => n + c.amountCents, 0),
    returned,
  };
}

export async function pendingBillLines(tx: Tx, poLineId: number) {
  const lines = await tx.vendorBillLine.findMany({ where: { poLineId, bill: { status: "POSTED", kind: "INVENTORY" } }, orderBy: [{ billId: "asc" }, { id: "asc" }] });
  const result = [];
  for (const line of lines) {
    const state = await billLineStock(tx, line.id);
    if (state.pending > 0) result.push({ ...line, pending: state.pending });
  }
  return result;
}

/** Freight posted before an inventory bill retains the same per-unit PO split. */
export async function unbilledInboundShare(tx: Tx, poLineId: number, qty: number) {
  const po = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } });
  const assigned = await tx.vendorBillLine.aggregate({ where: { poLineId, bill: { status: "POSTED", kind: "INVENTORY" } }, _sum: { inboundCents: true } });
  const unassigned = po.inboundCents - (assigned._sum.inboundCents ?? 0);
  const unbilled = Math.max(po.qtyOrdered, po.qtyReceived) - po.qtyBilled;
  return unbilled > 0 ? Math.round(unassigned * qty / unbilled) : 0;
}
