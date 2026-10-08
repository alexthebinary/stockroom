import { type AllocationBasis, DomainError } from "@pi/domain";
import { postEntry, reverseEntry } from "../ledger";
import { type StockCtx, unlandLot } from "../stock";
import { applyLineAdjustment } from "./adjust";
import { ensureDraftBill } from "./bills";
import { refreshPoStatus } from "./po";
import { refreshReceiptState } from "./receive";

/**
 * Void a posted bill. Refused while a payment or credit sits on it — undo
 * those first, or correct with a vendor credit instead.
 *
 * Inventory bill: units it landed go back to held (exactly the value they
 * brought leaves the pool), the bill's entry is reversed, and the PO gets a
 * fresh draft bill for those units. Refused once any of them has left stock,
 * or once a freight bill has been spread over the order (void that first).
 *
 * Freight-in bill: the same split is posted with the opposite sign, worked out
 * from where the units are TODAY — some may have sold since, so the reversal
 * can differ from the original by design.
 */
export async function voidBill(ctx: StockCtx, billId: number) {
  const { tx, actor } = ctx;
  await tx.$queryRaw`SELECT "id" FROM "VendorBill" WHERE "id" = ${billId} FOR UPDATE`;
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true, allocations: true } });
  if (bill.status !== "POSTED") throw new DomainError(`${bill.number} is ${bill.status.toLowerCase()}, not posted`, 409);
  const livePayments = await tx.payment.count({ where: { billId, status: "POSTED" } });
  if (livePayments > 0 || bill.paidCents !== 0) throw new DomainError(`${bill.number} has payments on it; void those first`, 409);
  if (bill.creditedCents !== 0) throw new DomainError(`${bill.number} has vendor credits on it and can't be voided`, 409);

  const billEntry = await tx.journalEntry.findFirstOrThrow({ where: { sourceType: "BILL", sourceId: billId, reversesId: null } });

  if (bill.kind === "INVENTORY") {
    const poLineIds = bill.lines.map((l) => l.poLineId!).filter(Boolean);
    const freight = await tx.landedCostAllocation.count({ where: { poLineId: { in: poLineIds }, freightBill: { status: "POSTED" } } });
    if (freight > 0) throw new DomainError("A freight bill is spread over this order; void the freight bill first", 409);
    const lots = await tx.inventoryLot.findMany({ where: { sourceType: "BILL", sourceId: billId } });
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: bill.poId! } });
    const unlanded = [];
    for (const lot of lots) {
      const receiptLine = await tx.receiptLine.findUniqueOrThrow({ where: { id: lot.receiptLineId! }, include: { receipt: true } });
      await unlandLot(ctx, lot.id, { docNumber: receiptLine.receipt.number, poId: po.id, billId });
      await tx.receiptLine.update({ where: { id: receiptLine.id }, data: { landedQty: { decrement: lot.qtyIn }, valueCents: { decrement: lot.valueCents } } });
      const serials = await tx.serialUnit.findMany({ where: { receiptLineId: receiptLine.id, state: "IN_STOCK" }, take: lot.qtyIn, orderBy: { id: "desc" } });
      await tx.serialUnit.updateMany({ where: { id: { in: serials.map((s) => s.id) } }, data: { state: "HELD" } });
      await tx.purchaseOrderLine.update({
        where: { id: lot.poLineId! },
        data: { qtyLanded: { decrement: lot.qtyIn }, qtyHeld: { increment: lot.qtyIn }, inboundCents: { increment: lot.valueCents } },
      });
      await refreshReceiptState(tx, receiptLine.receiptId);
      unlanded.push({ itemId: lot.itemId, poLineId: lot.poLineId!, valueCents: lot.valueCents });
    }
    if (unlanded.length) {
      await postEntry(tx, {
        event: "RECEIPT_LANDED",
        date: new Date(),
        sourceType: "BILL_VOID",
        sourceId: billId,
        actor,
        memo: `Units landed by ${bill.number} go back to awaiting a bill`,
        lines: unlanded.flatMap((u) => [
          { role: "inventoryOnHand" as const, amountCents: -u.valueCents, itemId: u.itemId, poLineId: u.poLineId },
          { role: "inventoryInbound" as const, amountCents: -u.valueCents, itemId: u.itemId, poLineId: u.poLineId },
        ]),
      });
    }
    for (const line of bill.lines.filter((l) => l.poLineId)) {
      await tx.purchaseOrderLine.update({
        where: { id: line.poLineId! },
        data: { qtyBilled: { decrement: line.qty }, billedCents: { decrement: line.landedCents }, inboundCents: { decrement: line.landedCents } },
      });
    }
    await reverseEntry(tx, billEntry.id, actor);
    await tx.vendorBill.update({ where: { id: billId }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actor } });
    await ensureDraftBill(tx, po.id, actor);
    await refreshPoStatus(tx, po.id);
    return tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  }

  if (bill.kind === "FREIGHT_IN") {
    const effects = [];
    for (const allocation of bill.allocations) {
      effects.push(await applyLineAdjustment(tx, allocation.poLineId, -allocation.amountCents));
    }
    await postEntry(tx, {
      event: "FREIGHT_IN_POSTED",
      date: new Date(),
      sourceType: "BILL_VOID",
      sourceId: billId,
      actor,
      memo: `Void ${bill.number} (${bill.allocationBasis as AllocationBasis} allocation reversed at today's stock)`,
      lines: [
        ...effects.flatMap((e) => [
          { role: "inventoryInbound" as const, amountCents: e.inbound, itemId: e.itemId, poLineId: e.poLineId },
          { role: "inventoryOnHand" as const, amountCents: e.onHand, itemId: e.itemId, poLineId: e.poLineId },
          { role: "cogs" as const, amountCents: e.cogs, itemId: e.itemId, poLineId: e.poLineId },
        ]),
        { role: "payable", amountCents: -bill.totalCents, vendorId: bill.vendorId! },
      ],
    });
    await tx.vendorBill.update({ where: { id: billId }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actor } });
    for (const poId of bill.targetPoIds) await refreshPoStatus(tx, poId);
    return tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  }

  await reverseEntry(tx, billEntry.id, actor);
  return tx.vendorBill.update({ where: { id: billId }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actor } });
}
