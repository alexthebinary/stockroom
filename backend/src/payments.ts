/**
 * Shared money helpers for the two payment paths.
 *
 * Sales and purchases are near-mirrors, and the mirror already drifted: the
 * `paymentId` argument added to /sales-orders/:id/reverse-payment was never
 * carried to the purchase side, so reversing a mis-keyed vendor deposit
 * silently reversed the wrong instalment instead. Two copies of the same
 * logic only need one of them to be updated to become a bug, so the identical
 * parts live here once.
 */
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Money actually received or paid against a document: live payments only,
 * summed fresh every time.
 *
 * Deliberately not a stored column. A payment can be reversed, and a cached
 * balance is a second source of truth that goes stale without anyone noticing.
 */
export async function paidAgainst(
  tx: Tx,
  document: { invoiceId: number } | { billId: number }
) {
  const where =
    "invoiceId" in document
      ? { invoiceId: document.invoiceId, status: { not: "VOID" } }
      : { billId: document.billId, status: { not: "VOID" } };

  const payments = await tx.payment.findMany({ where, select: { amountCents: true } });
  return payments.reduce((sum, p) => sum + p.amountCents, 0);
}

/**
 * Take a row lock on the document whose balance is about to be read.
 *
 * ⚠️ WITHOUT THIS, CONCURRENT PARTIAL PAYMENTS OVERPAY. Both /pay routes read
 * the outstanding balance with a plain SELECT, check the requested amount
 * against it, then insert a Payment — and nothing pinned the insert to the
 * value that was read. Under Postgres's default READ COMMITTED, two requests
 * for $300 against a $500 balance both read `alreadyPaid = 0`, both pass the
 * check, and both commit: $600 recorded against a $500 invoice. Neither one
 * settles the document, so the status-transition guard never fires either.
 *
 * This cannot happen on SQLite, which serialises every write through one
 * connection — which is exactly why 126 green tests never saw it and why the
 * bug only exists on the deployment the app is actually live on.
 *
 * The lock is a no-op on SQLite for that same reason. The table name is a
 * literal union rather than a string so it cannot carry an injection, and the
 * id is parameterised.
 */
export async function lockDocumentForPayment(
  tx: Tx,
  table: "Invoice" | "Bill" | "SalesOrder",
  id: number
) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) return;
  await tx.$executeRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
}
