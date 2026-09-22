/**
 * Booking goods in.
 *
 * ONE implementation, used by both the manual receive on a purchase order and
 * the camera scan on the dock. They were separate: the manual path created a
 * goods receipt, cost layers, stock movements and a journal entry, and the
 * scan incremented two integers. So the flagship feature — the thing an
 * operator actually uses, with gloves on — was the one that did not tell the
 * books anything, and stock arrived that had no cost and no entry behind it.
 *
 * Anything that puts stock on a shelf goes through here.
 */
import type { Prisma } from "@prisma/client";
import { ACCOUNT, TRANSACTION_TYPE } from "./accounts";
import { createLot } from "./costing";
import { badRequest, conflict } from "./errors";
import { applyBalanceDelta, recordMovement } from "./inventory";
import { createEntry, type DraftLine } from "./ledger";
import { nextGrnNumber } from "./numbering";

type Tx = Prisma.TransactionClient;

type OrderLine = {
  id: number;
  productId: number;
  warehouseId: number;
  quantity: number;
  receivedQty: number;
  unitCostCents: number;
  lineTotalCents: number;
  product: { sku: string };
};

type Order = {
  id: number;
  poNumber: string;
  status: string;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  lines: OrderLine[];
};

export const outstandingOf = (line: { quantity: number; receivedQty: number }) =>
  line.quantity - line.receivedQty;

/**
 * Receive `requested` (lineId -> quantity) against `order`.
 *
 * Returns the receipt it created, the entry it posted, and whether the order
 * is now complete. Throws rather than partially applying: the caller's
 * transaction is the unit of work.
 */
export async function receiveAgainstOrder(
  tx: Tx,
  { order, requested, actor }: { order: Order; requested: Map<number, number>; actor: string }
) {
  if (order.status !== "POSTED" && order.status !== "PAID") {
    throw conflict(
      `Only a posted or paid purchase order can be received (this one is ${order.status})`
    );
  }
  if (requested.size === 0) {
    throw badRequest(
      order.lines.every((l) => outstandingOf(l) === 0)
        ? "Everything on this order has already been received"
        : "Nothing to receive — every line was given a quantity of zero"
    );
  }

  const arriving = order.lines.filter((l) => requested.has(l.id));

  // Only named when THIS receipt lands in one warehouse. Two pallets to two
  // sites on one day are two receipts as far as the document is concerned.
  const warehouseIds = new Set(arriving.map((l) => l.warehouseId));
  const warehouseId = warehouseIds.size === 1 ? arriving[0].warehouseId : null;

  const grn = await tx.goodsReceipt.create({
    data: {
      grnNumber: await nextGrnNumber(tx),
      purchaseOrderId: order.id,
      warehouseId,
      status: "POSTED",
    },
  });

  /**
   * Each line's FULL landed cost, computed across the WHOLE order so the parts
   * always sum to the vendor's total — the last line absorbs the remainder. A
   * partial receipt then clears a slice of this, and the slices for a line
   * necessarily add back up to it.
   */
  const goodsCents = order.lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const extrasCents = order.taxCents + order.shippingCents;
  const fullLandedCost = new Map<number, number>();
  let extrasAllocated = 0;
  for (const [index, line] of order.lines.entries()) {
    const isLast = index === order.lines.length - 1;
    const lineExtras = isLast
      ? extrasCents - extrasAllocated
      : goodsCents > 0
        ? Math.round((extrasCents * line.lineTotalCents) / goodsCents)
        : 0;
    extrasAllocated += lineExtras;
    fullLandedCost.set(line.id, line.lineTotalCents + lineExtras);
  }

  /**
   * How much of a line's landed cost has been cleared by the time `n` units
   * have arrived. Exact at the end by construction, so the final unit of a
   * line clears precisely what is left and Prepaid Inventory reaches zero
   * however the deliveries were split — including one box at a time.
   */
  const clearedAt = (lineId: number, n: number, quantity: number) => {
    const full = fullLandedCost.get(lineId)!;
    if (n >= quantity) return full;
    if (n <= 0) return 0;
    return Math.round((full * n) / quantity);
  };

  let totalCostCents = 0;
  let prepaidClearedCents = 0;
  const createdLots: { lineId: number; lotId: number }[] = [];

  for (const line of arriving) {
    const qty = requested.get(line.id)!;
    const outstanding = outstandingOf(line);
    if (qty > outstanding) {
      throw badRequest(
        `${line.product.sku}: cannot receive ${qty}, only ${outstanding} outstanding`
      );
    }
    const nowReceived = line.receivedQty + qty;

    await applyBalanceDelta(
      tx,
      line.productId,
      line.warehouseId,
      { incomingQty: -qty, onHandQty: qty },
      `Cannot receive ${line.product.sku}`
    );

    const lineCost =
      clearedAt(line.id, nowReceived, line.quantity) -
      clearedAt(line.id, line.receivedQty, line.quantity);
    prepaidClearedCents += lineCost;

    const landedUnitCost = Math.round(lineCost / qty);
    const lot = await createLot(tx, {
      productId: line.productId,
      warehouseId: line.warehouseId,
      quantity: qty,
      unitCostCents: landedUnitCost,
      sourceType: "GOODS_RECEIPT",
      sourceId: grn.id,
    });
    createdLots.push({ lineId: line.id, lotId: lot.id });
    totalCostCents += landedUnitCost * qty;

    await recordMovement(tx, {
      productId: line.productId,
      toWarehouseId: line.warehouseId,
      quantity: qty,
      movementType: "PURCHASE_RECEIPT",
      reason: `Received on ${grn.grnNumber} (${order.poNumber})`,
      referenceType: "GOODS_RECEIPT",
      referenceId: grn.id,
      totalCostCents: lineCost,
      actor,
    });

    await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data: {
        receivedQty: nowReceived,
        status: nowReceived >= line.quantity ? "RECEIVED" : "PARTIAL",
      },
    });
  }

  // DELIVERED only when nothing is outstanding anywhere on the order.
  const after = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id } });
  const complete = after.every((l) => l.receivedQty >= l.quantity);
  if (complete) {
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: "DELIVERED" },
    });
    if (claimed.count === 0) throw conflict("This purchase order was already received");
  }

  await tx.goodsReceipt.update({ where: { id: grn.id }, data: { totalCostCents } });

  /**
   * Inventory gets exactly what the layers are worth, Prepaid is cleared by
   * exactly what this receipt's slice of the bill put there, and the
   * difference is NAMED as a rounding variance rather than stranded in either.
   */
  const varianceCents = prepaidClearedCents - totalCostCents;
  const entryLines: DraftLine[] = [
    { accountCode: ACCOUNT.INVENTORY, debitCents: totalCostCents, memo: "Value of the cost layers created" },
    {
      accountCode: ACCOUNT.PREPAID_INVENTORY,
      creditCents: prepaidClearedCents,
      memo: complete ? `Clears ${order.poNumber}` : `Part of ${order.poNumber} — ${grn.grnNumber}`,
    },
  ];
  if (varianceCents > 0) {
    entryLines.push({ accountCode: ACCOUNT.ROUNDING_VARIANCE, debitCents: varianceCents, memo: "Landed cost rounding" });
  } else if (varianceCents < 0) {
    entryLines.push({ accountCode: ACCOUNT.ROUNDING_VARIANCE, creditCents: -varianceCents, memo: "Landed cost rounding" });
  }

  const entry = await createEntry(tx, {
    transactionType: TRANSACTION_TYPE.GOODS_RECEIPT,
    lines: entryLines,
    memo: complete
      ? `Goods receipt ${grn.grnNumber} completes ${order.poNumber}`
      : `Goods receipt ${grn.grnNumber} part-receives ${order.poNumber}`,
    referenceType: "GOODS_RECEIPT",
    referenceId: grn.id,
    actor,
  });

  return { goodsReceipt: { ...grn, totalCostCents }, entry, complete, createdLots };
}
