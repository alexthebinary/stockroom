import { TRANSACTION_TYPE } from "./accounts";
import type { Tx } from "./inventory";
import { postRoles } from "./posting";

/** How credit notes are recorded against an invoice (returns.ts). */
const CREDIT_NOTE = "CREDIT_NOTE";

/**
 * Cash-basis sales tax (client's revised mapping, 2026-09-28).
 *
 * An invoice books its tax to 2200 Sales Tax Transition. As the customer pays,
 * the paid share becomes a real debt to the tax authority and moves to 2100
 * Sales Tax Payable. This recomputes where that share SHOULD be and posts only
 * the difference from what earlier syncs moved, so it is safe to call after
 * any event that changes cash or credit on the invoice — and idempotent.
 *
 *   taxOwed  = invoice tax − tax returned on credit notes
 *   netTotal = invoice total − credit notes
 *   cash     = payments − refunds (refunds are stored negative)
 *   target   = all of taxOwed once cash covers netTotal, else its paid share
 */
/** Where an invoice's tax stands: what is still owed, and what should be payable now. */
export async function taxPosition(tx: Tx, invoiceId: number) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status === "VOID") return { invoice, taxOwed: 0, target: 0 };
  const [payments, returns] = await Promise.all([
    tx.payment.findMany({
      where: { invoiceId, status: { not: "VOID" } },
      select: { amountCents: true, method: true },
    }),
    tx.salesReturn.findMany({ where: { invoiceId }, include: { lines: true } }),
  ]);
  const credits = payments.filter((p) => p.method === CREDIT_NOTE).reduce((s, p) => s + p.amountCents, 0);
  const cash = payments.filter((p) => p.method !== CREDIT_NOTE).reduce((s, p) => s + p.amountCents, 0);
  const taxReturned = returns.reduce(
    (s, r) => s + r.creditCents - r.lines.reduce((g, l) => g + l.quantity * l.unitPriceCents, 0),
    0
  );
  const taxOwed = invoice.taxCents - taxReturned;
  const netTotal = invoice.totalCents - credits;
  const target =
    netTotal <= 0 || taxOwed <= 0
      ? 0
      : cash >= netTotal
        ? taxOwed
        : Math.round((taxOwed * Math.max(cash, 0)) / netTotal);
  return { invoice, taxOwed, target };
}

export async function syncSalesTaxPayable(tx: Tx, invoiceId: number, actor: string) {
  const { invoice, target } = await taxPosition(tx, invoiceId);

  // What earlier syncs moved, read from their own entries: independent of
  // which accounts the rules point at today.
  const moves = await tx.journalEntry.findMany({
    where: {
      referenceType: "INVOICE_TAX",
      referenceId: invoiceId,
      status: "POSTED",
      transactionType: { in: [TRANSACTION_TYPE.SALES_TAX_RECOGNIZED, TRANSACTION_TYPE.SALES_TAX_UNRECOGNIZED] },
    },
    include: { lines: { select: { debitCents: true } } },
  });
  const moved = moves.reduce((s, e) => {
    const amount = e.lines.reduce((d, l) => d + l.debitCents, 0);
    return s + (e.transactionType === TRANSACTION_TYPE.SALES_TAX_RECOGNIZED ? amount : -amount);
  }, 0);

  const delta = target - moved;
  if (delta === 0) return null;
  const recognize = delta > 0;
  return postRoles(tx, {
    transactionType: recognize ? TRANSACTION_TYPE.SALES_TAX_RECOGNIZED : TRANSACTION_TYPE.SALES_TAX_UNRECOGNIZED,
    amounts: { transition: Math.abs(delta), payable: Math.abs(delta) },
    memo: `${recognize ? "Tax collected" : "Tax no longer collected"} on ${invoice.invoiceNumber}`,
    referenceType: "INVOICE_TAX",
    referenceId: invoiceId,
    actor,
  });
}
