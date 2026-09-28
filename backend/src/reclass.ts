import { prisma } from "./db";
import { ACCOUNT, TRANSACTION_TYPE } from "./accounts";
import { postRoles } from "./posting";
import { syncSalesTaxPayable, taxPosition } from "./sales_tax";

/**
 * One-time correction for the client's revised mapping (2026-09-28).
 *
 * Invoices posted before the split credited their whole total to 4000 Sales
 * Revenue, sales tax and shipping included. For each, post ONE dated,
 * labelled entry moving the tax still owed to 2200 and the shipping to 4100,
 * then let the cash-basis sync move the paid share of tax on to 2100. The
 * originals are never touched, and each correction reverses on its own.
 *
 * Idempotent: skips an invoice that already has a reclass entry, or whose
 * invoice entry was posted with the split (a line on 2200 or 4100).
 */
export async function reclassHistoricalInvoices(actor = "system:reclass-2026-09-28") {
  const invoices = await prisma.invoice.findMany({ where: { status: "POSTED" }, orderBy: { id: "asc" } });
  let count = 0;
  for (const inv of invoices) {
    const done = await prisma.journalEntry.count({ where: { referenceType: "INVOICE_RECLASS", referenceId: inv.id } });
    if (done) continue;
    const splitEra = await prisma.journalLine.count({
      where: {
        journalEntry: { referenceType: "INVOICE", referenceId: inv.id, transactionType: TRANSACTION_TYPE.SALES_INVOICE },
        account: { code: { in: [ACCOUNT.SALES_TAX_TRANSITION, ACCOUNT.SHIPPING_INCOME] } },
      },
    });
    if (splitEra) continue;

    try {
      const posted = await prisma.$transaction(async (tx) => {
        const { taxOwed } = await taxPosition(tx, inv.id);
        const tax = Math.max(0, taxOwed);
        const shipping = inv.shippingCents;
        if (tax + shipping === 0) return false;
        await postRoles(tx, {
          transactionType: TRANSACTION_TYPE.REVENUE_RECLASS,
          amounts: { revenue: tax + shipping, salesTax: tax, shippingIncome: shipping },
          memo: `Reclass 2026-09-28: tax and shipping out of revenue (${inv.invoiceNumber})`,
          referenceType: "INVOICE_RECLASS",
          referenceId: inv.id,
          actor,
        });
        await syncSalesTaxPayable(tx, inv.id, actor);
        return true;
      });
      if (posted) count++;
    } catch (err) {
      // A closed period, most likely. Leave it visible rather than stop boot.
      console.error(`Reclass skipped for ${inv.invoiceNumber}: ${(err as Error).message}`);
    }
  }
  return count;
}
