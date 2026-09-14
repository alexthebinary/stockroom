import type { Tx } from "./inventory";

/**
 * Document numbers.
 *
 * Allocated from a counter row that is incremented in place, not from
 * `max(id)`. The old approach read the highest id and added to it inside the
 * transaction with no lock: on Postgres, two concurrent creates read the same
 * maximum and minted the same number, and the loser was told it had created a
 * duplicate record when it had done nothing wrong. SQLite serialises writers,
 * so that race could never appear in local development — the classic shape of
 * a bug that only exists in production.
 *
 * `update` on a single row takes a row lock for the duration of the
 * transaction, so concurrent callers queue rather than collide. That
 * serialises document creation, which at this volume costs nothing.
 *
 * Numbers stay gapless in normal use, because the counter only advances when a
 * document is actually created. A rolled-back transaction releases the lock
 * and the number with it. NOTE: gapless-by-construction is NOT the same as the
 * legal guarantee some jurisdictions require for tax invoices — see L10 in the
 * open questions before relying on it.
 */
type CounterKind = keyof typeof COUNTERS;

/**
 * kind -> [prefix, first number issued, digits]. The base is the number the
 * first document of that type carries, so the counter itself always starts at
 * 1 and the prefix arithmetic stays in one place.
 */
const COUNTERS = {
  SALES_ORDER: ["SO", 1001, 6],
  PURCHASE_ORDER: ["PO", 2001, 6],
  INVOICE: ["INV", 1, 6],
  BILL: ["BILL", 1, 6],
  PAYMENT: ["PAY", 1, 6],
  SHIPMENT: ["SHP", 1, 6],
  GOODS_RECEIPT: ["GRN", 1, 6],
  JOURNAL_ENTRY: ["JE", 1, 6],
} as const;

async function nextNumber(tx: Tx, kind: CounterKind) {
  const [prefix, base, width] = COUNTERS[kind];
  // A plain update, no create: ensureDocumentCounters() guarantees the row at
  // boot. Creating it here would mean a create that can fail inside the
  // caller's transaction, and on Postgres a failed statement poisons the whole
  // transaction — trading a numbering race for a worse one.
  const row = await tx.documentCounter.update({
    where: { kind },
    data: { lastValue: { increment: 1 } },
  });
  return `${prefix}-${String(row.lastValue + base - 1).padStart(width, "0")}`;
}

/**
 * Make sure every counter row exists, starting from the highest number already
 * issued. Runs at boot for the same reason the chart of accounts does: a
 * database created before a counter existed would otherwise start it at zero
 * and reissue numbers that are already in use.
 */
export async function ensureDocumentCounters() {
  const { prisma } = await import("./db");

  /**
   * The highest number in use, as a counter value. Derived from the numeric
   * tail of the number itself, never from a row count: deleting a draft lowers
   * the count, which would reissue a number that already exists.
   */
  const top = (numbers: string[], base: number) =>
    numbers.reduce((max, n) => {
      const tail = Number(String(n).split("-")[1]);
      return Number.isFinite(tail) ? Math.max(max, tail - base + 1) : max;
    }, 0);

  const highest: Record<CounterKind, number> = {
    SALES_ORDER: top((await prisma.salesOrder.findMany({ select: { orderNumber: true } })).map((r) => r.orderNumber), 1001),
    PURCHASE_ORDER: top((await prisma.purchaseOrder.findMany({ select: { poNumber: true } })).map((r) => r.poNumber), 2001),
    INVOICE: top((await prisma.invoice.findMany({ select: { invoiceNumber: true } })).map((r) => r.invoiceNumber), 1),
    BILL: top((await prisma.bill.findMany({ select: { billNumber: true } })).map((r) => r.billNumber), 1),
    PAYMENT: top((await prisma.payment.findMany({ select: { paymentNumber: true } })).map((r) => r.paymentNumber), 1),
    SHIPMENT: top((await prisma.shipment.findMany({ select: { shipmentNumber: true } })).map((r) => r.shipmentNumber), 1),
    GOODS_RECEIPT: top((await prisma.goodsReceipt.findMany({ select: { grnNumber: true } })).map((r) => r.grnNumber), 1),
    JOURNAL_ENTRY: top((await prisma.journalEntry.findMany({ select: { entryNumber: true } })).map((r) => r.entryNumber), 1),
  };

  const existing = new Set(
    (await prisma.documentCounter.findMany({ select: { kind: true } })).map((c) => c.kind)
  );
  const missing = (Object.keys(COUNTERS) as CounterKind[])
    .filter((k) => !existing.has(k))
    .map((kind) => ({ kind, lastValue: highest[kind] }));
  if (missing.length === 0) return [];
  await prisma.documentCounter.createMany({ data: missing });
  return missing.map((m) => `${m.kind}=${m.lastValue}`);
}


export const nextSalesOrderNumber = (tx: Tx) => nextNumber(tx, "SALES_ORDER");
export const nextPurchaseOrderNumber = (tx: Tx) => nextNumber(tx, "PURCHASE_ORDER");
export const nextInvoiceNumber = (tx: Tx) => nextNumber(tx, "INVOICE");
export const nextBillNumber = (tx: Tx) => nextNumber(tx, "BILL");
export const nextPaymentNumber = (tx: Tx) => nextNumber(tx, "PAYMENT");
export const nextShipmentNumber = (tx: Tx) => nextNumber(tx, "SHIPMENT");
export const nextGrnNumber = (tx: Tx) => nextNumber(tx, "GOODS_RECEIPT");
export const nextJournalEntryNumber = (tx: Tx) => nextNumber(tx, "JOURNAL_ENTRY");
