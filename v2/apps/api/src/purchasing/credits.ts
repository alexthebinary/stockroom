import { DomainError } from "@pi/domain";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits, type StockCtx } from "../stock";
import { applyLineAdjustment } from "./adjust";
import { refreshPoStatus } from "./po";
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
 * by what the vendor credits; any difference between the two is a return
 * variance (COGS by default). In the guide's examples they are equal, so the
 * entry is simply Dr AP / Cr Inventory.
 *
 * RETURN of units billed but never received: Dr AP / Cr Inventory – Inbound.
 *
 * PRICE_ALLOWANCE: the line costs less — split exactly like late freight.
 */
export async function postVendorCredit(
  ctx: StockCtx,
  billId: number,
  input: { kind: "RETURN" | "PRICE_ALLOWANCE"; date: Date; memo?: string | null; lines: CreditLineInput[] },
) {
  const { tx, actor } = ctx;
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true } });
  if (bill.kind !== "INVENTORY" || bill.status !== "POSTED") throw new DomainError("Credits apply to a posted inventory bill", 409);
  if (input.lines.length === 0) throw new DomainError("Pick at least one line", 400);
  const number = await nextNumber(tx, "VC");
  const credit = await tx.vendorCredit.create({ data: { number, kind: input.kind, vendorId: bill.vendorId!, billId, date: input.date, totalCents: 0, memo: input.memo, actor } });

  const entryLines = [];
  let total = 0;
  for (const req of input.lines) {
    const billLine = bill.lines.find((l) => l.id === req.billLineId);
    if (!billLine?.poLineId || !billLine.itemId) throw new DomainError(`Line ${req.billLineId} is not on ${bill.number}`, 400);
    const poLine = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: billLine.poLineId } });
    const item = await tx.item.findUniqueOrThrow({ where: { id: billLine.itemId } });

    if (input.kind === "PRICE_ALLOWANCE") {
      const amount = req.amountCents ?? 0;
      if (amount <= 0) throw new DomainError(`${item.name}: enter the discount amount`, 400);
      if (amount > billLine.landedCents) throw new DomainError(`${item.name}: a discount can't exceed what the line cost`, 400);
      const effect = await applyLineAdjustment(tx, poLine.id, -amount);
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
    const amount = req.amountCents ?? Math.round((billLine.landedCents * req.qty) / billLine.qty);
    if (amount < 0) throw new DomainError("A credit can't be negative", 400);
    const received = req.received ?? true;
    let costCents: number;
    if (received) {
      if (req.qty > poLine.qtyLanded) throw new DomainError(`${item.name}: only ${poLine.qtyLanded} unit(s) from this order are in stock to return`, 400);
      if (item.trackingMode === "SERIAL") {
        const serials = req.serials ?? [];
        if (serials.length !== req.qty) throw new DomainError(`${item.name}: name the serial of each unit going back`, 400);
        const units = await tx.serialUnit.updateMany({ where: { itemId: item.id, serial: { in: serials }, state: "IN_STOCK" }, data: { state: "RETURNED" } });
        if (units.count !== serials.length) throw new DomainError(`${item.name}: one of those serials is not in stock`, 400);
      }
      const warehouseId = (await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poLine.poId } })).warehouseId;
      costCents = await issueUnits(ctx, { itemId: item.id, warehouseId, qty: req.qty, docNumber: number, counter: { type: "VENDOR_CREDIT", id: credit.id }, preferPoLineId: poLine.id });
      entryLines.push({ role: "inventoryOnHand" as const, amountCents: costCents, itemId: item.id, poLineId: poLine.id });
      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { qtyReturned: { increment: req.qty }, qtyOrdered: { decrement: req.qty }, qtyBilled: { decrement: req.qty }, qtyReceived: { decrement: req.qty }, qtyLanded: { decrement: req.qty }, billedCents: { decrement: amount } },
      });
    } else {
      const notLanded = poLine.qtyBilled - poLine.qtyLanded;
      if (req.qty > notLanded) throw new DomainError(`${item.name}: only ${notLanded} billed unit(s) have not arrived`, 400);
      costCents = inboundShare(poLine.inboundCents, notLanded, req.qty);
      entryLines.push({ role: "inventoryInbound" as const, amountCents: costCents, itemId: item.id, poLineId: poLine.id });
      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: { qtyOrdered: { decrement: req.qty }, qtyBilled: { decrement: req.qty }, inboundCents: { decrement: costCents }, billedCents: { decrement: amount } },
      });
    }
    entryLines.push({ role: "returnVariance" as const, amountCents: amount - costCents, itemId: item.id, poLineId: poLine.id });
    await tx.vendorCreditLine.create({ data: { creditId: credit.id, billLineId: billLine.id, poLineId: poLine.id, itemId: item.id, qty: req.qty, amountCents: amount, costCents } });
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
