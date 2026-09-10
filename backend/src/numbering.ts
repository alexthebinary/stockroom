import type { Tx } from "./inventory";

/**
 * Document numbers.
 *
 * Derived from the highest id ever allocated, not from the row count: a count
 * goes DOWN when a draft is deleted, which would reissue a number that already
 * exists and trip the unique index. Autoincrement ids never go back.
 */
async function nextNumber(
  prefix: string,
  base: number,
  maxId: () => Promise<{ id: number } | null>,
  width = 6
) {
  const top = await maxId();
  return `${prefix}-${String((top?.id ?? 0) + base).padStart(width, "0")}`;
}

export const nextSalesOrderNumber = (tx: Tx) =>
  nextNumber("SO", 1001, () => tx.salesOrder.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextPurchaseOrderNumber = (tx: Tx) =>
  nextNumber("PO", 2001, () => tx.purchaseOrder.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextInvoiceNumber = (tx: Tx) =>
  nextNumber("INV", 1, () => tx.invoice.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextBillNumber = (tx: Tx) =>
  nextNumber("BILL", 1, () => tx.bill.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextPaymentNumber = (tx: Tx) =>
  nextNumber("PAY", 1, () => tx.payment.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextShipmentNumber = (tx: Tx) =>
  nextNumber("SHP", 1, () => tx.shipment.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));

export const nextGrnNumber = (tx: Tx) =>
  nextNumber("GRN", 1, () => tx.goodsReceipt.findFirst({ orderBy: { id: "desc" }, select: { id: true } }));
