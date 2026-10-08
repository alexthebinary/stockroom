import { type AllocationBasis, DomainError } from "@pi/domain";
import type { Tx } from "../db";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import type { StockCtx } from "../stock";
import { applyLineAdjustment, freightTargets } from "./adjust";
import { dueDateFor } from "./bills";
import { refreshPoStatus } from "./po";

/** A carrier's bill: freight-in (spread over the orders it carried) or freight-out (an expense). */
export async function draftFreightBill(
  tx: Tx,
  input: {
    kind: "FREIGHT_IN" | "FREIGHT_OUT";
    vendorId: number;
    vendorInvoiceNumber?: string | null;
    billDate: Date;
    termsDays?: number;
    amountCents: number;
    targetPoIds: number[];
    allocationBasis: AllocationBasis;
    notes?: string | null;
  },
) {
  const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new DomainError("Choose the carrier", 400);
  if (input.kind === "FREIGHT_IN" && input.targetPoIds.length === 0) throw new DomainError("Pick the purchase order(s) this freight brought in", 400);
  const termsDays = input.termsDays ?? vendor.paymentTermsDays;
  return tx.vendorBill.create({
    data: {
      number: await nextNumber(tx, "BILL"),
      kind: input.kind,
      vendorId: vendor.id,
      vendorInvoiceNumber: input.vendorInvoiceNumber,
      billDate: input.billDate,
      termsDays,
      dueDate: dueDateFor(input.billDate, termsDays),
      targetPoIds: input.targetPoIds,
      allocationBasis: input.allocationBasis,
      subtotalCents: input.amountCents,
      totalCents: input.amountCents,
      notes: input.notes,
      lines: { create: [{ description: input.kind === "FREIGHT_IN" ? "Inbound freight" : "Outbound freight", amountCents: input.amountCents }] },
    },
    include: { lines: true },
  });
}

/** Where each dollar of a freight-in bill would go, without posting. */
export async function previewFreight(tx: Tx, billId: number) {
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  const targets = await freightTargets(tx, bill.targetPoIds, bill.totalCents, bill.allocationBasis as AllocationBasis);
  const items = await tx.item.findMany({ where: { id: { in: targets.map((t) => t.itemId) } } });
  return targets.map((t) => ({ ...t, item: items.find((i) => i.id === t.itemId) }));
}

export async function postFreightBill(ctx: StockCtx, billId: number, expectedVersion: number) {
  const { tx, actor } = ctx;
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  if (bill.status !== "DRAFT") throw new DomainError(`${bill.number} is already ${bill.status.toLowerCase()}`, 409);
  if (bill.version !== expectedVersion) throw new DomainError(`${bill.number} was changed by someone else. Reload it and post again.`, 409);
  if (!bill.vendorId) throw new DomainError("Choose the carrier before posting", 400);
  if (!bill.vendorInvoiceNumber?.trim()) throw new DomainError("Enter the carrier's invoice number before posting", 400);
  if (bill.totalCents <= 0) throw new DomainError("A freight bill needs an amount", 400);
  const duplicate = await tx.vendorBill.findFirst({
    where: { id: { not: bill.id }, vendorId: bill.vendorId, status: "POSTED", vendorInvoiceNumber: { equals: bill.vendorInvoiceNumber.trim(), mode: "insensitive" } },
  });
  if (duplicate) throw new DomainError(`Invoice ${bill.vendorInvoiceNumber} from this carrier is already on ${duplicate.number}`, 409);
  const claimed = await tx.vendorBill.updateMany({ where: { id: billId, status: "DRAFT", version: expectedVersion }, data: { status: "POSTED", postedAt: new Date(), postedBy: actor, version: { increment: 1 } } });
  if (claimed.count === 0) throw new DomainError(`${bill.number} was posted or changed by someone else. Reload it.`, 409);
  const payable = { role: "payable" as const, amountCents: bill.totalCents, vendorId: bill.vendorId };

  if (bill.kind === "FREIGHT_OUT") {
    // GAAP guide §II.1, Vendor Bill – Freight-Out: Dr Outbound Shipping Expense / Cr AP.
    await postEntry(tx, { event: "FREIGHT_OUT_POSTED", date: bill.billDate, sourceType: "BILL", sourceId: bill.id, actor, memo: bill.number, lines: [{ role: "outboundShipping", amountCents: bill.totalCents }, payable] });
    return tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  }

  // GAAP guide §II.1, Vendor Bill – Freight-In: Dr Inventory Asset / Cr AP, allocated to the PO lines.
  const targets = await freightTargets(tx, bill.targetPoIds, bill.totalCents, bill.allocationBasis as AllocationBasis);
  if (targets.length === 0) throw new DomainError("The chosen orders have nothing on them to carry this freight", 400);
  const effects = [];
  for (const target of targets) {
    const effect = await applyLineAdjustment(tx, target.poLineId, target.amountCents);
    effects.push(effect);
    await tx.landedCostAllocation.create({
      data: { freightBillId: bill.id, poLineId: target.poLineId, amountCents: target.amountCents, inboundCents: effect.inbound, onHandCents: effect.onHand, soldCents: effect.cogs },
    });
  }
  await postEntry(tx, {
    event: "FREIGHT_IN_POSTED",
    date: bill.billDate,
    sourceType: "BILL",
    sourceId: bill.id,
    actor,
    memo: bill.number,
    lines: [
      ...effects.flatMap((e) => [
        { role: "inventoryInbound" as const, amountCents: e.inbound, itemId: e.itemId, poLineId: e.poLineId },
        { role: "inventoryOnHand" as const, amountCents: e.onHand, itemId: e.itemId, poLineId: e.poLineId },
        { role: "cogs" as const, amountCents: e.cogs, itemId: e.itemId, poLineId: e.poLineId },
      ]),
      payable,
    ],
  });
  for (const poId of bill.targetPoIds) await refreshPoStatus(tx, poId);
  return tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { allocations: true } });
}
