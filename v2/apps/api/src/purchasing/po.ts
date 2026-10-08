import { billingStatus, DomainError, paymentStatus, receivingStatus } from "@pi/domain";
import type { Tx } from "../db";
import { nextNumber } from "../numbering";

/**
 * Recompute a PO's three status axes from the documents beneath it. Called in
 * the same transaction as anything that changes those documents, so the axes
 * are never stale and never set by hand.
 */
export async function refreshPoStatus(tx: Tx, poId: number) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true, bills: true } });
  const inventoryBills = po.bills.filter((b) => b.kind === "INVENTORY");
  const posted = inventoryBills.filter((b) => b.status === "POSTED");
  const owed = posted.reduce((s, b) => s + b.totalCents - b.creditedCents, 0);
  const paid = posted.reduce((s, b) => s + b.paidCents, 0);
  return tx.purchaseOrder.update({
    where: { id: poId },
    data: {
      billingStatus: billingStatus(inventoryBills),
      paymentStatus: posted.length === 0 ? "UNPAID" : paymentStatus(owed, paid),
      receivingStatus: receivingStatus(po.lines),
      version: { increment: 1 },
    },
  });
}

export type NewPoLine = { itemId: number; qtyOrdered: number; unitCostCents: number; addedAtDock?: boolean };

export async function createPo(
  tx: Tx,
  input: { vendorId: number | null; warehouseId: number; source: "MANUAL" | "SCAN"; notes?: string; actor: string; lines: NewPoLine[] },
) {
  const items = await tx.item.findMany({ where: { id: { in: input.lines.map((l) => l.itemId) } } });
  for (const line of input.lines) {
    const item = items.find((i) => i.id === line.itemId);
    if (!item || !item.isActive) throw new DomainError(`Item ${line.itemId} is not an active item`, 400);
  }
  const number = await nextNumber(tx, "PO");
  return tx.purchaseOrder.create({
    data: {
      number,
      vendorId: input.vendorId,
      warehouseId: input.warehouseId,
      source: input.source,
      notes: input.notes,
      createdBy: input.actor,
      lines: { create: input.lines.map((l) => ({ itemId: l.itemId, qtyOrdered: l.qtyOrdered, unitCostCents: l.unitCostCents, addedAtDock: l.addedAtDock ?? false })) },
    },
    include: { lines: true },
  });
}

/** The best guess at what a unit costs before the bill says: slip, then this vendor's last price, then ours. */
export async function estimateCost(tx: Tx, itemId: number, vendorId: number | null, slipPriceCents?: number | null) {
  if (slipPriceCents != null) return slipPriceCents;
  if (vendorId) {
    const vendorItem = await tx.vendorItem.findFirst({ where: { vendorId, itemId, lastCostCents: { not: null } } });
    if (vendorItem?.lastCostCents != null) return vendorItem.lastCostCents;
  }
  return (await tx.item.findUniqueOrThrow({ where: { id: itemId } })).lastCostCents;
}
