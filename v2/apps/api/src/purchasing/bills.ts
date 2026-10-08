import { type AllocationBasis, DomainError, landedCost, type LandedLine } from "@pi/domain";
import type { Tx } from "../db";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { landUnits, type StockCtx } from "../stock";
import { refreshPoStatus } from "./po";
import { inboundShare, refreshReceiptState } from "./receive";

const DAY = 86_400_000;
export const dueDateFor = (billDate: Date, termsDays: number) => new Date(billDate.getTime() + termsDays * DAY);

/**
 * Make sure a PO that is holding received-but-unbilled units has a draft bill
 * for them. A draft nobody has touched yet (version 0) is refreshed to match
 * what has arrived; once accounting has edited it, it is left alone and the
 * received-vs-billed variance shows on the bill desk instead.
 */
export async function ensureDraftBill(tx: Tx, poId: number, actor: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } });
  const unbilled = po.lines.filter((l) => l.qtyReceived > l.qtyBilled).map((l) => ({ line: l, qty: l.qtyReceived - l.qtyBilled }));
  if (unbilled.length === 0) return null;
  const existing = await tx.vendorBill.findFirst({ where: { poId, kind: "INVENTORY", status: "DRAFT" }, orderBy: { id: "asc" } });
  if (existing && existing.version > 0) return existing;
  const vendor = po.vendorId ? await tx.vendor.findUnique({ where: { id: po.vendorId } }) : null;
  const termsDays = vendor?.paymentTermsDays ?? 30;
  const billDate = new Date();
  const lines = unbilled.map(({ line, qty }) => ({ poLineId: line.id, itemId: line.itemId, qty, unitCostCents: line.unitCostCents }));
  if (existing) {
    await tx.vendorBillLine.deleteMany({ where: { billId: existing.id } });
    await tx.vendorBillLine.createMany({ data: lines.map((l) => ({ ...l, billId: existing.id })) });
    return recomputeTotals(tx, existing.id);
  }
  const bill = await tx.vendorBill.create({
    data: {
      number: await nextNumber(tx, "BILL"),
      kind: "INVENTORY",
      source: po.source === "SCAN" ? "SCAN" : "MANUAL",
      vendorId: po.vendorId,
      poId,
      billDate,
      termsDays,
      dueDate: dueDateFor(billDate, termsDays),
      notes: `Drafted from what arrived at the dock (${actor})`,
      lines: { create: lines },
    },
  });
  return recomputeTotals(tx, bill.id);
}

/** A bill for a PO drafted by accounting before goods arrive: one line per line not yet billed. */
export async function draftBillFromPo(tx: Tx, poId: number) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } });
  const lines = po.lines.filter((l) => l.qtyOrdered > l.qtyBilled).map((l) => ({ poLineId: l.id, itemId: l.itemId, qty: l.qtyOrdered - l.qtyBilled, unitCostCents: l.unitCostCents }));
  if (lines.length === 0) throw new DomainError(`Everything on ${po.number} is already billed`, 409);
  const vendor = po.vendorId ? await tx.vendor.findUnique({ where: { id: po.vendorId } }) : null;
  const termsDays = vendor?.paymentTermsDays ?? 30;
  const billDate = new Date();
  const bill = await tx.vendorBill.create({
    data: {
      number: await nextNumber(tx, "BILL"),
      kind: "INVENTORY",
      vendorId: po.vendorId,
      poId,
      billDate,
      termsDays,
      dueDate: dueDateFor(billDate, termsDays),
      lines: { create: lines },
    },
  });
  return recomputeTotals(tx, bill.id);
}

function landedFor(bill: { freightCents: number; allocationBasis: string; lines: { id: number; qty: number; unitCostCents: number; discountCents: number }[] }): LandedLine[] {
  const lines = bill.lines.filter((l) => l.qty > 0);
  return landedCost(
    lines.map((l) => ({ key: String(l.id), qty: l.qty, unitCostCents: l.unitCostCents, discountCents: l.discountCents })),
    bill.freightCents,
    bill.allocationBasis as AllocationBasis,
  );
}

export async function recomputeTotals(tx: Tx, billId: number) {
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true } });
  if (bill.kind !== "INVENTORY") {
    const total = bill.lines.reduce((s, l) => s + l.amountCents, 0);
    return tx.vendorBill.update({ where: { id: billId }, data: { subtotalCents: total, totalCents: total } });
  }
  const landed = bill.lines.some((l) => l.qty > 0) ? landedFor(bill) : [];
  const subtotal = landed.reduce((s, l) => s + l.goodsCents, 0);
  return tx.vendorBill.update({ where: { id: billId }, data: { subtotalCents: subtotal, totalCents: subtotal + bill.freightCents } });
}

/**
 * What posting this bill would do, computed by the same code that posts it:
 * landed cost per line, the units that will land right away, and the entry.
 */
export async function previewBill(tx: Tx, billId: number) {
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true } });
  if (bill.kind !== "INVENTORY") {
    return { kind: bill.kind, lines: [], totalCents: bill.totalCents, landing: [], entry: null };
  }
  const landed = bill.lines.some((l) => l.qty > 0) ? landedFor(bill) : [];
  const poLines = await tx.purchaseOrderLine.findMany({ where: { id: { in: bill.lines.map((l) => l.poLineId!).filter(Boolean) } } });
  const landing = landed.map((l) => {
    const billLine = bill.lines.find((b) => String(b.id) === l.key)!;
    const poLine = poLines.find((p) => p.id === billLine.poLineId)!;
    const billedAfter = poLine.qtyBilled + l.qty;
    const units = Math.min(poLine.qtyHeld, billedAfter - poLine.qtyLanded);
    const inboundAfter = poLine.inboundCents + l.landedCents;
    return { billLineId: billLine.id, itemId: billLine.itemId!, units, valueCents: units > 0 ? inboundShare(inboundAfter, billedAfter - poLine.qtyLanded, units) : 0 };
  });
  const total = landed.reduce((s, l) => s + l.landedCents, 0);
  return {
    kind: bill.kind,
    totalCents: total,
    lines: landed.map((l) => ({ billLineId: Number(l.key), goodsCents: l.goodsCents, freightCents: l.freightCents, landedCents: l.landedCents, landedUnitCents: l.landedUnitCents })),
    landing,
    entry: [
      { role: "inventoryInbound", side: "DEBIT", amountCents: total },
      { role: "payable", side: "CREDIT", amountCents: total },
    ],
  };
}

/**
 * Post an inventory bill (GAAP guide §II.1): Dr Inventory – Inbound / Cr AP
 * at landed cost, freight on the bill spread over its lines. Units already
 * waiting at the dock for this bill land in the same transaction (WH-IN
 * against the bill: Dr On Hand / Cr Inbound) and become sellable stock.
 */
export async function postInventoryBill(ctx: StockCtx, billId: number, expectedVersion: number) {
  const { tx, actor } = ctx;
  const bill = await tx.vendorBill.findUnique({ where: { id: billId }, include: { lines: true } });
  if (!bill) throw new DomainError("That bill was not found", 404);
  if (bill.status !== "DRAFT") throw new DomainError(`${bill.number} is already ${bill.status.toLowerCase()}`, 409);
  if (bill.version !== expectedVersion) throw new DomainError(`${bill.number} was changed by someone else. Reload it and post again.`, 409);
  if (!bill.vendorId) throw new DomainError("Choose the vendor before posting", 400);
  if (!bill.vendorInvoiceNumber?.trim()) throw new DomainError("Enter the vendor's invoice number before posting", 400);
  const duplicate = await tx.vendorBill.findFirst({
    where: { id: { not: bill.id }, vendorId: bill.vendorId, status: "POSTED", vendorInvoiceNumber: { equals: bill.vendorInvoiceNumber.trim(), mode: "insensitive" } },
  });
  if (duplicate) throw new DomainError(`Invoice ${bill.vendorInvoiceNumber} from this vendor is already on ${duplicate.number}`, 409);
  // Claimed atomically: of two people pressing Post at once, one wins and the other gets a 409.
  const claimed = await tx.vendorBill.updateMany({ where: { id: billId, status: "DRAFT", version: expectedVersion }, data: { status: "POSTED", postedAt: new Date(), postedBy: actor } });
  if (claimed.count === 0) throw new DomainError(`${bill.number} was posted or changed by someone else. Reload it.`, 409);
  const lines = bill.lines.filter((l) => l.qty > 0);
  if (lines.length === 0) throw new DomainError("A bill needs at least one line with a quantity", 400);

  const landed = landedFor(bill);
  const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: bill.vendorId } });
  const entryLines = [];
  let total = 0;
  for (const l of landed) {
    const billLine = lines.find((b) => String(b.id) === l.key)!;
    const poLine = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: billLine.poLineId! } });
    if (poLine.qtyBilled + l.qty > Math.max(poLine.qtyOrdered, poLine.qtyReceived)) {
      throw new DomainError(`Line ${billLine.id} bills ${l.qty} but only ${Math.max(poLine.qtyOrdered, poLine.qtyReceived) - poLine.qtyBilled} are ordered or received and not yet billed`, 400);
    }
    await tx.vendorBillLine.update({ where: { id: billLine.id }, data: { freightCents: l.freightCents, landedCents: l.landedCents } });
    await tx.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: { qtyBilled: { increment: l.qty }, billedCents: { increment: l.landedCents }, inboundCents: { increment: l.landedCents } },
    });
    const unitCost = Math.round(l.goodsCents / l.qty);
    await tx.item.update({ where: { id: billLine.itemId! }, data: { lastCostCents: unitCost } });
    await tx.vendorItem.updateMany({ where: { vendorId: vendor.id, itemId: billLine.itemId! }, data: { lastCostCents: unitCost } });
    entryLines.push({ role: "inventoryInbound" as const, amountCents: l.landedCents, itemId: billLine.itemId!, poLineId: poLine.id });
    total += l.landedCents;
  }
  await tx.vendorBill.update({ where: { id: bill.id }, data: { totalCents: total, subtotalCents: total - bill.freightCents, version: { increment: 1 } } });
  await postEntry(tx, {
    event: "BILL_POSTED",
    date: bill.billDate,
    sourceType: "BILL",
    sourceId: bill.id,
    actor,
    memo: `${bill.number} · ${vendor.name} invoice ${bill.vendorInvoiceNumber}`,
    lines: [...entryLines, { role: "payable", amountCents: total, vendorId: vendor.id }],
  });

  await landHeldUnits(ctx, bill.id, bill.poId!, lines.map((l) => l.poLineId!), bill.billDate);
  await refreshPoStatus(tx, bill.poId!);
  return tx.vendorBill.findUniqueOrThrow({ where: { id: bill.id }, include: { lines: true } });
}

/** Held units on these PO lines that the bill now covers land, oldest receipt first. */
async function landHeldUnits(ctx: StockCtx, billId: number, poId: number, poLineIds: number[], billDate: Date) {
  const { tx, actor } = ctx;
  const byReceipt = new Map<number, { itemId: number; poLineId: number; valueCents: number }[]>();
  for (const poLineId of poLineIds) {
    let line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } });
    let toLand = Math.min(line.qtyHeld, line.qtyBilled - line.qtyLanded);
    if (toLand <= 0) continue;
    const pending = await tx.receiptLine.findMany({ where: { poLineId, receipt: { poId } }, include: { receipt: true }, orderBy: { id: "asc" } });
    for (const receiptLine of pending) {
      const waiting = receiptLine.qty - receiptLine.landedQty;
      if (waiting <= 0 || toLand === 0) continue;
      const n = Math.min(waiting, toLand);
      const valueCents = inboundShare(line.inboundCents, line.qtyBilled - line.qtyLanded, n);
      await landUnits(ctx, {
        itemId: line.itemId,
        warehouseId: receiptLine.receipt.warehouseId,
        qty: n,
        valueCents,
        fromHeld: true,
        docNumber: receiptLine.receipt.number,
        counter: { type: "BILL", id: billId },
        poLineId,
        receiptLineId: receiptLine.id,
      });
      await tx.receiptLine.update({ where: { id: receiptLine.id }, data: { landedQty: { increment: n }, valueCents: { increment: valueCents } } });
      const heldSerials = await tx.serialUnit.findMany({ where: { receiptLineId: receiptLine.id, state: "HELD" }, orderBy: { id: "asc" }, take: n });
      await tx.serialUnit.updateMany({ where: { id: { in: heldSerials.map((s) => s.id) } }, data: { state: "IN_STOCK" } });
      line = await tx.purchaseOrderLine.update({
        where: { id: poLineId },
        data: { qtyHeld: { decrement: n }, qtyLanded: { increment: n }, inboundCents: { decrement: valueCents } },
      });
      const list = byReceipt.get(receiptLine.receiptId) ?? [];
      list.push({ itemId: line.itemId, poLineId, valueCents });
      byReceipt.set(receiptLine.receiptId, list);
      toLand -= n;
    }
  }
  for (const [receiptId, landed] of byReceipt) {
    const receipt = await tx.warehouseReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    await postEntry(tx, {
      event: "RECEIPT_LANDED",
      date: receipt.receivedAt > billDate ? receipt.receivedAt : billDate,
      sourceType: "RECEIPT",
      sourceId: receiptId,
      actor,
      memo: `${receipt.number} lands against the bill`,
      lines: landed.flatMap((l) => [
        { role: "inventoryOnHand" as const, amountCents: l.valueCents, itemId: l.itemId, poLineId: l.poLineId },
        { role: "inventoryInbound" as const, amountCents: l.valueCents, itemId: l.itemId, poLineId: l.poLineId },
      ]),
    });
    await refreshReceiptState(tx, receiptId);
  }
}
