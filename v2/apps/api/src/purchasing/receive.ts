import { DomainError, receiptState } from "@pi/domain";
import type { Tx } from "../db";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { holdUnits, landUnits, type StockCtx } from "../stock";
import { ensureDraftBill } from "./bills";
import { createPo, estimateCost, refreshPoStatus } from "./po";

export type Arrival = { itemId: number; qty: number; serials: string[]; slipPriceCents?: number | null };

export type ReceiveResult = {
  poIds: number[];
  receiptIds: number[];
  /** WH-IN document numbers, for the printed receipt. */
  receiptNumbers: string[];
  draftBillIds: number[];
  landedUnits: number;
  heldUnits: number;
};

/**
 * Value of `n` units landing from a PO line's inbound value when `remaining`
 * billed units have yet to land: telescoping, so the last unit clears exactly
 * what is left (freight-in added later included).
 */
export function inboundShare(inboundCents: number, remaining: number, n: number) {
  if (n >= remaining) return inboundCents;
  return Math.round((inboundCents * n) / remaining);
}

/**
 * Goods physically arrived at a warehouse. Against `poId` when the delivery
 * was matched to an order; otherwise a new PO (source SCAN) is opened for it.
 *
 * Per item, units fill the PO's outstanding lines. Of those, units the
 * vendor has ALREADY billed land at once (WH-IN against the bill: Dr On Hand
 * / Cr Inbound). The rest are held — counted, not valued — until accounting
 * posts the bill. Units beyond the order go onto the same PO while it is
 * unbilled, or onto a new PO if its bill is already posted (a posted bill is
 * never edited). Every PO left holding units gets a draft bill.
 */
export async function receive(
  ctx: StockCtx,
  input: { warehouseId: number; vendorId: number | null; poId: number | null; arrivals: Arrival[]; scanSessionId?: number; date?: Date },
): Promise<ReceiveResult> {
  const { tx, actor } = ctx;
  const arrivals = input.arrivals.filter((a) => a.qty > 0);
  if (arrivals.length === 0) throw new DomainError("Nothing was counted, so nothing was received", 400);
  const items = await tx.item.findMany({ where: { id: { in: arrivals.map((a) => a.itemId) } } });
  for (const a of arrivals) {
    const item = items.find((i) => i.id === a.itemId)!;
    if (item.trackingMode === "SERIAL" && a.serials.length !== a.qty) {
      throw new DomainError(`${item.name}: ${a.qty} counted but ${a.serials.length} serial number(s). Scan or type a serial for each unit.`, 400);
    }
    if (new Set(a.serials).size !== a.serials.length) throw new DomainError(`${item.name}: the same serial was scanned twice`, 400);
  }

  let po = input.poId ? await tx.purchaseOrder.findUnique({ where: { id: input.poId }, include: { lines: true, bills: true } }) : null;
  if (input.poId && !po) throw new DomainError("That purchase order was not found", 404);
  if (po && po.lifecycle !== "OPEN") throw new DomainError(`${po.number} is ${po.lifecycle.toLowerCase()}; receive against an open order`, 409);
  const vendorId = po?.vendorId ?? input.vendorId;

  // Split each arrival into what the target PO expected, and the extras.
  type Planned = { itemId: number; poLineId: number | null; qty: number; serials: string[]; slipPriceCents?: number | null };
  const expected: Planned[] = [];
  const extras: Planned[] = [];
  for (const a of arrivals) {
    let left = a.qty;
    let serials = [...a.serials];
    for (const line of po?.lines.filter((l) => l.itemId === a.itemId) ?? []) {
      const outstanding = line.qtyOrdered - line.qtyReceived;
      if (outstanding <= 0 || left === 0) continue;
      const n = Math.min(outstanding, left);
      expected.push({ itemId: a.itemId, poLineId: line.id, qty: n, serials: serials.slice(0, n) });
      serials = serials.slice(n);
      left -= n;
    }
    if (left > 0) extras.push({ itemId: a.itemId, poLineId: null, qty: left, serials, slipPriceCents: a.slipPriceCents });
  }

  const touched: { poId: number; planned: Planned[] }[] = [];
  if (po && expected.length) touched.push({ poId: po.id, planned: expected });
  if (extras.length) {
    const poHasPostedBill = po?.bills.some((b) => b.kind === "INVENTORY" && b.status === "POSTED") ?? false;
    if (po && !poHasPostedBill) {
      // Still unbilled: the order simply grows to what arrived.
      for (const extra of extras) {
        const line = po.lines.find((l) => l.itemId === extra.itemId);
        const poLine = line
          ? await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { qtyOrdered: { increment: extra.qty } } })
          : await tx.purchaseOrderLine.create({
              data: { poId: po.id, itemId: extra.itemId, qtyOrdered: extra.qty, unitCostCents: await estimateCost(tx, extra.itemId, vendorId, extra.slipPriceCents), addedAtDock: true },
            });
        extra.poLineId = poLine.id;
      }
      const existing = touched.find((t) => t.poId === po!.id);
      if (existing) existing.planned.push(...extras);
      else touched.push({ poId: po.id, planned: extras });
    } else {
      const lines = [];
      for (const extra of extras) {
        lines.push({ itemId: extra.itemId, qtyOrdered: extra.qty, unitCostCents: await estimateCost(tx, extra.itemId, vendorId, extra.slipPriceCents), addedAtDock: po != null });
      }
      const created = await createPo(tx, {
        vendorId,
        warehouseId: input.warehouseId,
        source: "SCAN",
        actor,
        notes: po ? `Arrived with ${po.number} but not on it` : "Created at the dock from a scan",
        lines,
      });
      extras.forEach((extra, i) => (extra.poLineId = created.lines[i]!.id));
      touched.push({ poId: created.id, planned: extras });
    }
  }

  const result: ReceiveResult = { poIds: [], receiptIds: [], receiptNumbers: [], draftBillIds: [], landedUnits: 0, heldUnits: 0 };
  for (const { poId, planned } of touched) {
    const docNumber = await nextNumber(tx, "WH_IN");
    const receipt = await tx.warehouseReceipt.create({
      data: { number: docNumber, poId, warehouseId: input.warehouseId, scanSessionId: input.scanSessionId, receivedBy: actor, receivedAt: input.date ?? new Date() },
    });
    const landedLines = [];
    for (const p of planned) {
      const line = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: p.poLineId! } });
      const landable = Math.min(p.qty, Math.max(0, line.qtyBilled - line.qtyLanded));
      const held = p.qty - landable;
      const receiptLine = await tx.receiptLine.create({ data: { receiptId: receipt.id, poLineId: line.id, itemId: p.itemId, qty: p.qty } });
      let valueCents = 0;
      if (landable > 0) {
        const bill = await tx.vendorBill.findFirst({
          where: { poId, kind: "INVENTORY", status: "POSTED", lines: { some: { poLineId: line.id } } },
          orderBy: { id: "desc" },
        });
        valueCents = inboundShare(line.inboundCents, line.qtyBilled - line.qtyLanded, landable);
        await landUnits(ctx, {
          itemId: p.itemId,
          warehouseId: input.warehouseId,
          qty: landable,
          valueCents,
          fromHeld: false,
          docNumber,
          counter: { type: "BILL", id: bill!.id },
          poLineId: line.id,
          receiptLineId: receiptLine.id,
        });
        landedLines.push({ itemId: p.itemId, poLineId: line.id, valueCents });
        await tx.receiptLine.update({ where: { id: receiptLine.id }, data: { landedQty: landable, valueCents } });
      }
      if (held > 0) await holdUnits(ctx, { itemId: p.itemId, warehouseId: input.warehouseId, qty: held, docNumber, poId });
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { qtyReceived: { increment: p.qty }, qtyLanded: { increment: landable }, qtyHeld: { increment: held }, inboundCents: { decrement: valueCents } },
      });
      for (const [i, serial] of p.serials.entries()) {
        try {
          await tx.serialUnit.create({ data: { itemId: p.itemId, serial, warehouseId: input.warehouseId, receiptLineId: receiptLine.id, state: i < landable ? "IN_STOCK" : "HELD" } });
        } catch {
          throw new DomainError(`Serial ${serial} has already been received`, 409);
        }
      }
      result.landedUnits += landable;
      result.heldUnits += held;
    }
    if (landedLines.length) {
      await postEntry(tx, {
        event: "RECEIPT_LANDED",
        date: input.date ?? new Date(),
        sourceType: "RECEIPT",
        sourceId: receipt.id,
        actor,
        memo: docNumber,
        lines: landedLines.flatMap((l) => [
          { role: "inventoryOnHand" as const, amountCents: l.valueCents, itemId: l.itemId, poLineId: l.poLineId },
          { role: "inventoryInbound" as const, amountCents: l.valueCents, itemId: l.itemId, poLineId: l.poLineId },
        ]),
      });
    }
    await refreshReceiptState(tx, receipt.id);
    const poNow = await tx.purchaseOrderLine.findMany({ where: { poId } });
    if (poNow.some((l) => l.qtyReceived > l.qtyBilled)) {
      const draft = await ensureDraftBill(tx, poId, actor);
      if (draft) result.draftBillIds.push(draft.id);
    }
    await refreshPoStatus(tx, poId);
    result.poIds.push(poId);
    result.receiptIds.push(receipt.id);
    result.receiptNumbers.push(docNumber);
  }
  return result;
}

export async function refreshReceiptState(tx: Tx, receiptId: number) {
  const lines = await tx.receiptLine.findMany({ where: { receiptId } });
  await tx.warehouseReceipt.update({ where: { id: receiptId }, data: { state: receiptState(lines) } });
}
