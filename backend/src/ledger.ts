import { badRequest, conflict, notFound } from "./errors";
import type { Tx } from "./inventory";
import { JOURNAL_TEMPLATES, type TransactionType } from "./accounts";
import { assertPeriodOpen } from "./period";

export type DraftLine = {
  accountCode: string;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
  productId?: number;
  warehouseId?: number;
};

async function nextEntryNumber(tx: Tx) {
  // From the highest id, not the count — deleting a SAVED entry must not
  // reissue a number that already exists.
  const top = await tx.journalEntry.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
  return `JE-${String((top?.id ?? 0) + 1).padStart(6, "0")}`;
}

/**
 * Create a journal entry and, unless told otherwise, post it.
 *
 * Two invariants, both enforced here rather than trusted to callers:
 *  - every line is one-sided (a debit or a credit, never both, never neither)
 *  - total debits equal total credits, to the cent
 *
 * An entry that fails either is refused, which means an unbalanced ledger
 * cannot be written even by a buggy caller.
 */
export async function createEntry(
  tx: Tx,
  input: {
    transactionType: TransactionType;
    lines: DraftLine[];
    memo?: string;
    referenceType?: string;
    referenceId?: number;
    actor: string;
    entryDate?: Date;
    post?: boolean;
  }
) {
  const { lines } = input;
  if (lines.length < 2) {
    throw badRequest("A journal entry needs at least two lines");
  }

  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    const debit = line.debitCents ?? 0;
    const credit = line.creditCents ?? 0;
    // Money is integer cents. A fractional value would be accepted by SQLite's
    // INTEGER column and quietly drift the books, so it is refused here.
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) {
      throw badRequest("Journal amounts must be whole cents");
    }
    if (debit < 0 || credit < 0) throw badRequest("Journal amounts cannot be negative");
    if (debit === 0 && credit === 0) throw badRequest("A journal line must carry an amount");
    if (debit > 0 && credit > 0) {
      throw badRequest("A journal line is either a debit or a credit, not both");
    }
    debits += debit;
    credits += credit;
  }
  if (debits !== credits) {
    throw badRequest(
      `Journal entry does not balance: debits ${debits} vs credits ${credits} (cents)`
    );
  }
  if (debits === 0) throw badRequest("A journal entry cannot be for zero");

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await tx.account.findMany({ where: { code: { in: codes } } });
  const missing = codes.find((c) => !accounts.some((a) => a.code === c));
  if (missing) throw notFound(`Account ${missing} is not in the chart of accounts`);
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));

  const post = input.post !== false;
  const entryDate = input.entryDate ?? new Date();
  await assertPeriodOpen(tx, entryDate, "This entry cannot be posted");

  return tx.journalEntry.create({
    data: {
      entryNumber: await nextEntryNumber(tx),
      transactionType: input.transactionType,
      entryDate,
      memo: input.memo ?? null,
      status: post ? "POSTED" : "SAVED",
      postedAt: post ? new Date() : null,
      hasBeenPosted: post,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      actor: input.actor,
      lines: {
        create: lines.map((l) => ({
          accountId: idByCode.get(l.accountCode)!,
          debitCents: l.debitCents ?? 0,
          creditCents: l.creditCents ?? 0,
          memo: l.memo ?? null,
          productId: l.productId ?? null,
          warehouseId: l.warehouseId ?? null,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
}

/**
 * Convenience for the common case: a single debit and a single credit for the
 * same amount, using the accounts configured for that transaction type.
 */
export async function postSimple(
  tx: Tx,
  input: {
    transactionType: TransactionType;
    amountCents: number;
    memo?: string;
    referenceType?: string;
    referenceId?: number;
    actor: string;
    productId?: number;
    debitWarehouseId?: number;
    creditWarehouseId?: number;
  }
) {
  const template = JOURNAL_TEMPLATES.find((t) => t.transactionType === input.transactionType);
  if (!template) throw badRequest(`No journal template for ${input.transactionType}`);
  if (input.amountCents < 0) {
    throw badRequest(`${input.transactionType}: amount cannot be negative`);
  }
  // Zero-cost stock is legitimate (promotional, samples, free replacements).
  // There is nothing to post, but the movement itself must still succeed, so
  // this is a no-op rather than an error.
  if (input.amountCents === 0) return null;

  return createEntry(tx, {
    transactionType: input.transactionType,
    memo: input.memo ?? template.description,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    actor: input.actor,
    lines: [
      {
        accountCode: template.debitAccountCode,
        debitCents: input.amountCents,
        productId: input.productId,
        warehouseId: input.debitWarehouseId,
      },
      {
        accountCode: template.creditAccountCode,
        creditCents: input.amountCents,
        productId: input.productId,
        warehouseId: input.creditWarehouseId,
      },
    ],
  });
}

/**
 * Is anything downstream depending on this entry?
 *
 * The scope allows unposting only when a transaction "is not connected to
 * other transactions". Walking forward from the document the entry belongs to
 * is the only way to answer that — an allowlist of reference types cannot,
 * because it does not know that a Payment now stands on a Bill.
 */
export async function dependenciesOf(tx: Tx, entry: {
  referenceType: string | null;
  referenceId: number | null;
}): Promise<string | null> {
  const { referenceType, referenceId } = entry;
  if (!referenceType || !referenceId) return null;

  // A reversal standing against this entry is the strongest dependency there
  // is: deleting the original would leave a contra entry with nothing to
  // contra, silently moving the books with no record of why.
  const reversal = await tx.journalEntry.findFirst({
    where: {
      referenceType,
      referenceId,
      transactionType: { endsWith: "_REVERSAL" },
      status: "POSTED",
    },
  });
  if (reversal) {
    return `${reversal.entryNumber} already reverses it — deleting the original would orphan that reversal`;
  }

  switch (referenceType) {
    case "BILL": {
      const payments = await tx.payment.count({
        where: { billId: referenceId, status: { not: "VOID" } },
      });
      return payments > 0 ? "a payment has been made against this bill" : null;
    }
    case "INVOICE": {
      const payments = await tx.payment.count({
        where: { invoiceId: referenceId, status: { not: "VOID" } },
      });
      return payments > 0 ? "a payment has been received against this invoice" : null;
    }
    // A physical movement has already changed stock and consumed cost layers;
    // the ledger cannot be walked back without also reversing the movement.
    case "SHIPMENT":
      return "this entry records a shipment that has already left the warehouse";
    case "GOODS_RECEIPT":
      return "this entry records goods that have already been received";
    case "STOCK_TRANSFER":
      return "this entry records stock that has already moved between warehouses";
    case "STOCK_ADJUSTMENT":
      return "this entry records a stock adjustment that has already been applied";
    default:
      return null;
  }
}

/**
 * The document this entry belongs to, when that document still claims to be
 * posted. Returned as a human label because the caller only needs to name it.
 */
async function postedDocumentFor(tx: Tx, entry: { referenceType: string | null; referenceId: number | null }) {
  const { referenceType, referenceId } = entry;
  if (!referenceType || !referenceId) return null;

  switch (referenceType) {
    case "INVOICE": {
      const doc = await tx.invoice.findUnique({ where: { id: referenceId } });
      return doc && doc.status !== "VOID" && doc.status !== "SAVED" ? `invoice ${doc.invoiceNumber}` : null;
    }
    case "BILL": {
      const doc = await tx.bill.findUnique({ where: { id: referenceId } });
      return doc && doc.status !== "VOID" && doc.status !== "SAVED" ? `bill ${doc.billNumber}` : null;
    }
    case "PAYMENT": {
      const doc = await tx.payment.findUnique({ where: { id: referenceId } });
      return doc && doc.status !== "VOID" ? `payment ${doc.paymentNumber}` : null;
    }
    default:
      return null;
  }
}

/**
 * Unpost an entry, but only when nothing downstream depends on it.
 */
export async function unpostEntry(tx: Tx, id: number) {
  const entry = await tx.journalEntry.findUnique({ where: { id } });
  if (!entry) throw notFound("Journal entry not found");
  if (entry.status !== "POSTED") throw conflict("Only a posted entry can be unposted");

  await assertPeriodOpen(tx, entry.entryDate, `${entry.entryNumber} cannot be unposted`);

  const blocker = await dependenciesOf(tx, entry);
  if (blocker) {
    throw conflict(`${entry.entryNumber} cannot be unposted: ${blocker}`);
  }

  // The document is the source of truth and the entry is its accounting
  // projection, so an entry off the books while its document still reads
  // POSTED is incoherent — the money vanishes from every report while the
  // paperwork insists it happened. Undo goes through the document instead.
  const owner = await postedDocumentFor(tx, entry);
  if (owner) {
    throw conflict(
      `${entry.entryNumber} belongs to ${owner}, which is still posted. ` +
        `Void or cancel the document instead — that reverses this entry with it.`
    );
  }

  // Claim the transition, so two concurrent unposts cannot both succeed.
  const claimed = await tx.journalEntry.updateMany({
    where: { id, status: "POSTED" },
    data: { status: "SAVED", postedAt: null },
  });
  if (claimed.count === 0) throw conflict("This entry was already unposted");

  return tx.journalEntry.findUniqueOrThrow({ where: { id } });
}

/**
 * Re-post an entry that was unposted.
 *
 * Without this, unposting is a one-way door: the entry drops out of every
 * POSTED-filtered report (the trial balance included) while the document it
 * belongs to still says it is posted, and nothing can put it back. That is a
 * silently wrong ledger reachable by one documented, intended action.
 *
 * `hasBeenPosted` is deliberately not cleared by unposting, so an entry that
 * comes back through here keeps its history.
 */
export async function repostEntry(tx: Tx, id: number) {
  const entry = await tx.journalEntry.findUnique({ where: { id } });
  if (!entry) throw notFound("Journal entry not found");
  if (entry.status === "POSTED") throw conflict("This entry is already posted");
  if (entry.status === "VOID") throw conflict("A void entry cannot be posted — reverse it instead");
  await assertPeriodOpen(tx, entry.entryDate, `${entry.entryNumber} cannot be re-posted`);

  // Claim the transition, so two concurrent re-posts cannot both succeed.
  const claimed = await tx.journalEntry.updateMany({
    where: { id, status: entry.status },
    data: { status: "POSTED", postedAt: new Date(), hasBeenPosted: true },
  });
  if (claimed.count === 0) throw conflict("This entry was already changed");

  return tx.journalEntry.findUniqueOrThrow({ where: { id } });
}

/**
 * Reverse a posted entry by posting its mirror image.
 *
 * This is how a posted transaction is undone in double-entry bookkeeping: the
 * original stays on the record and a contra entry cancels it, so the audit
 * trail shows both what happened and that it was reversed. Deleting history is
 * never the answer.
 */
export async function reverseEntry(
  tx: Tx,
  id: number,
  input: { actor: string; memo?: string }
) {
  const original = await tx.journalEntry.findUnique({
    where: { id },
    include: { lines: { include: { account: true } } },
  });
  if (!original) throw notFound("Journal entry not found");
  if (original.status !== "POSTED") {
    throw conflict("Only a posted entry can be reversed");
  }
  if (original.transactionType.endsWith("_REVERSAL")) {
    throw conflict("A reversal cannot itself be reversed");
  }

  const existing = await tx.journalEntry.findFirst({
    where: {
      transactionType: `${original.transactionType}_REVERSAL`,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      status: "POSTED",
    },
  });
  if (existing) {
    throw conflict(`${original.entryNumber} has already been reversed by ${existing.entryNumber}`);
  }

  return tx.journalEntry.create({
    data: {
      entryNumber: await nextEntryNumber(tx),
      transactionType: `${original.transactionType}_REVERSAL`,
      entryDate: new Date(),
      memo: input.memo ?? `Reversal of ${original.entryNumber}`,
      status: "POSTED",
      postedAt: new Date(),
      hasBeenPosted: true,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      actor: input.actor,
      lines: {
        // Debits become credits and vice versa — the mirror image balances
        // by construction because the original did.
        create: original.lines.map((l) => ({
          accountId: l.accountId,
          debitCents: l.creditCents,
          creditCents: l.debitCents,
          memo: `Reversal: ${l.memo ?? original.entryNumber}`,
          productId: l.productId,
          warehouseId: l.warehouseId,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
}

/** Reverse whatever posted entry is attached to a document. */
export async function reverseDocumentEntry(
  tx: Tx,
  referenceType: string,
  referenceId: number,
  input: { actor: string; memo?: string }
) {
  const entry = await tx.journalEntry.findFirst({
    where: { referenceType, referenceId, status: "POSTED" },
    orderBy: { id: "asc" },
  });
  if (!entry) return null;
  return reverseEntry(tx, entry.id, input);
}

/** Running balance of an account, respecting its normal side. */
export function balanceOf(
  normalSide: string,
  totals: { debitCents: number; creditCents: number }
) {
  return normalSide === "DEBIT"
    ? totals.debitCents - totals.creditCents
    : totals.creditCents - totals.debitCents;
}
