import { DomainError, State } from "@pi/domain";
import { transition } from "../transition";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits, revaluePool, type StockCtx } from "../stock";
import { applyLineAdjustment, billLineStock } from "./adjust";
import { refreshPoStatus } from "./po";
import { lockBill } from "./locks";
import { inboundShare } from "./receive";

export type CreditLineInput = {
  billLineId: number;
  /** RETURN: units going back (or never coming). PRICE_ALLOWANCE: 0. */
  qty: number;
  /** What the vendor credits for this line. Defaults to the line's landed cost of those units. */
  amountCents?: number;
  /** RETURN only: true = units on our shelf go back; false = billed units that never arrived. */
  received?: boolean;
  serials?: string[];
};

/**
 * A vendor credit against one posted inventory bill (GAAP guide §II.1 #3, #4,
 * #6, #7, #8). Every line names its item.
 *
 * RETURN of received units: they leave at AVERAGE cost (WH-OUT); AP is debited
 * by what the vendor credits. The remaining pool absorbs the difference so
 * the entry is Dr AP / Cr Inventory for the credit amount. Only a difference
 * the pool cannot absorb goes to return variance (Vendor Return Variance, 6950, by default).
 *
 * RETURN of units billed but never received: Dr AP / Cr Inventory Asset (in transit).
 *
 * PRICE_ALLOWANCE: the line costs less — split exactly like late freight.
 */
export async function postVendorCredit(
  ctx: StockCtx,
  billId: number,
  input: { kind: "RETURN" | "PRICE_ALLOWANCE"; date: Date; memo?: string | null; lines: CreditLineInput[] },
) {
  const { tx, actor } = ctx;
  await lockBill(tx, billId);
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true } });
  if (bill.kind !== "INVENTORY" || bill.status !== State.bill.POSTED) throw new DomainError("Credits apply to a posted inventory bill", 409);
  if (input.lines.length === 0) throw new DomainError("Pick at least one line", 400);
  const number = await nextNumber(tx, "VC");
  const credit = await tx.vendorCredit.create({ data: { number, kind: input.kind, vendorId: bill.vendorId!, billId, date: input.date, totalCents: 0, memo: input.memo, actor } });

  const entryLines = [];
  let total = 0;
  for (const req of input.lines) {
    if (!bill.lines.some(l => l.id === req.billLineId)) throw new DomainError(`Line ${req.billLineId} is not on ${bill.number}`, 400);
    // Earlier lines in this request may already have returned or discounted it.
    const billLine = await tx.vendorBillLine.findUniqueOrThrow({ where: { id: req.billLineId } });
    if (!billLine.poLineId || !billLine.itemId) throw new DomainError(`Line ${req.billLineId} is not on ${bill.number}`, 400);
    const poLine = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: billLine.poLineId } });
    const item = await tx.item.findUniqueOrThrow({ where: { id: billLine.itemId } });

    const owned = await billLineStock(tx, billLine.id);
    if (input.kind === "PRICE_ALLOWANCE") {
      const amount = req.amountCents ?? 0;
      if (amount <= 0) throw new DomainError(`${item.name}: enter the discount amount`, 400);
      if (amount > billLine.landedCents - owned.credited) throw new DomainError(`${item.name}: a discount can't exceed what the line cost`, 400);
      const effect = await applyLineAdjustment(tx, poLine.id, -amount, billLine.id);
      entryLines.push(
        { role: "inventoryInbound" as const, amountCents: -effect.inbound, itemId: item.id, poLineId: poLine.id },
        { role: "inventoryOnHand" as const, amountCents: -effect.onHand, itemId: item.id, poLineId: poLine.id },
        { role: "cogs" as const, amountCents: -effect.cogs, itemId: item.id, poLineId: poLine.id },
      );
      await tx.vendorCreditLine.create({ data: { creditId: credit.id, billLineId: billLine.id, poLineId: poLine.id, itemId: item.id, amountCents: amount } });
      total += amount;
      continue;
    }

    if (!Number.isInteger(req.qty) || req.qty <= 0) throw new DomainError(`${item.name}: enter how many units`, 400);
    if (req.qty > owned.remaining) throw new DomainError(`${item.name}: only ${owned.remaining} unit(s) remain returnable on this bill line`, 400);
    const amount = req.amountCents ?? inboundShare(Math.max(0, billLine.landedCents - owned.credited), owned.remaining, req.qty);
    if (amount < 0) throw new DomainError("A credit can't be negative", 400);
    const received = req.received ?? true;
    let costCents: number;
    let varianceCents: number;
    if (received) {
      if (req.qty > owned.onHand) throw new DomainError(`${item.name}: only ${owned.onHand} unit(s) from this bill line are in stock to return`, 400);
      const warehouseId = (await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poLine.poId } })).warehouseId;
      let lotIds: number[] | undefined;
      if (item.trackingMode === "SERIAL") {
        const serials = req.serials ?? [];
        if (serials.length !== req.qty) throw new DomainError(`${item.name}: name the serial of each unit going back`, 400);
        const lots = await tx.inventoryLot.findMany({ where: { billLineId: billLine.id, warehouseId, qtyRemaining: { gt: 0 } } });
        const units = await tx.serialUnit.findMany({ where: { itemId: item.id, warehouseId, serial: { in: serials }, state: State.serialUnit.IN_STOCK, lotId: { in: lots.map(l => l.id) } } });
        if (new Set(serials).size !== serials.length || units.length !== serials.length) throw new DomainError(`${item.name}: one of those serials is not in stock on this bill`, 400);
        lotIds = units.map(u => u.lotId!);
        // Issue each named lot separately: a serial in one lot must never consume another lot.
        await transition({
          machine: "serialUnit",
          to: State.serialUnit.RETURNED,
          from: [State.serialUnit.IN_STOCK],
          label: "Serial",
          apply: async (sources, to) => (await tx.serialUnit.updateMany({
            where: { id: { in: units.map(u => u.id) }, state: { in: sources } },
            data: { state: to },
          })).count,
          current: async () => State.serialUnit.IN_STOCK,
        });
      }
      costCents = 0;
      for (const group of lotIds ? lotIds.map(id => ({ qty: 1, lotIds: [id] })) : [{ qty: req.qty, lotIds: undefined }]) {
        costCents += await issueUnits(ctx, { itemId: item.id, warehouseId, qty: group.qty, docNumber: number, counter: { type: "VENDOR_CREDIT", id: credit.id }, billLineId: billLine.id, lotIds: group.lotIds });
      }
      // revaluePool returns the signed value change it could not apply.
      // Negate it back to the credit-side sign used by the return entry.
      varianceCents = -(await revaluePool(tx, item.id, -(amount - costCents)));
      entryLines.push({ role: "inventoryOnHand" as const, amountCents: amount - varianceCents, itemId: item.id, poLineId: poLine.id });
      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { qtyReturned: { increment: req.qty }, qtyOrdered: { decrement: req.qty }, qtyBilled: { decrement: req.qty }, qtyReceived: { decrement: req.qty }, qtyLanded: { decrement: req.qty }, billedCents: { decrement: amount } },
      });
    } else {
      const notLanded = owned.pending;
      if (req.qty > notLanded) throw new DomainError(`${item.name}: only ${notLanded} billed unit(s) have not arrived`, 400);
      costCents = inboundShare(billLine.inboundCents, notLanded, req.qty);
      await tx.vendorBillLine.update({ where: { id: billLine.id }, data: { inboundCents: { decrement: costCents } } });
      varianceCents = amount - costCents;
      entryLines.push({ role: "inventoryInbound" as const, amountCents: costCents, itemId: item.id, poLineId: poLine.id });
      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { qtyOrdered: { decrement: req.qty }, qtyBilled: { decrement: req.qty }, inboundCents: { decrement: costCents }, billedCents: { decrement: amount } },
      });
    }
    entryLines.push({ role: "returnVariance" as const, amountCents: varianceCents, itemId: item.id, poLineId: poLine.id });
    await tx.vendorCreditLine.create({ data: { creditId: credit.id, billLineId: billLine.id, poLineId: poLine.id, itemId: item.id, qty: req.qty, received, amountCents: amount, costCents } });
    total += amount;
  }

  const event = input.kind === "RETURN" ? "PURCHASE_RETURN" : "VENDOR_PRICE_ALLOWANCE";
  await postEntry(tx, {
    event,
    date: input.date,
    sourceType: "VENDOR_CREDIT",
    sourceId: credit.id,
    actor,
    memo: `${number} against ${bill.number}`,
    lines: [{ role: "payable", amountCents: total, vendorId: bill.vendorId! }, ...entryLines],
  });
  await tx.vendorCredit.update({ where: { id: credit.id }, data: { totalCents: total } });
  await tx.vendorBill.update({ where: { id: billId }, data: { creditedCents: { increment: total } } });
  await refreshPoStatus(tx, bill.poId!);
  return tx.vendorCredit.findUniqueOrThrow({ where: { id: credit.id }, include: { lines: true } });
}
