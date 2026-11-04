import { Prisma, type Tx } from "../db";

/**
 * Purchasing lock order: all PO lines (ascending id), then the bill, then
 * stock/numbering. Lock the whole PO because receipt/draft refresh and void
 * can touch lines beyond the current bill. Always re-read state afterwards.
 */
export async function lockPoLinesForOrders(tx: Tx, poIds: number[]) {
  const ids = [...new Set(poIds)];
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrderLine"
    WHERE "poId" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
}

export async function lockBill(tx: Tx, billId: number) {
  // This read only locates the locks. Status, version and lines are read by
  // the caller after locking; a concurrent edit/post cannot supply stale data.
  const bill = await tx.vendorBill.findUnique({ where: { id: billId }, select: { poId: true, targetPoIds: true } });
  if (bill) await lockPoLinesForOrders(tx, bill.poId ? [bill.poId] : bill.targetPoIds);
  await tx.$queryRaw`SELECT "id" FROM "VendorBill" WHERE "id" = ${billId} FOR UPDATE`;
}
