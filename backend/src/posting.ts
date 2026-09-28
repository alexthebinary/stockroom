import { prisma } from "./db";
import { ApiError, badRequest } from "./errors";
import type { Tx } from "./inventory";
import { ACCOUNT, CHART_OF_ACCOUNTS, JOURNAL_TEMPLATES, type TransactionType } from "./accounts";
import { createEntry, type DraftLine } from "./ledger";

/**
 * Account Assignment (client request 2026-09-28).
 *
 * Code declares WHAT a transaction posts: its roles, the side each is on, and
 * which kinds of account each may use. The database decides WHERE: one
 * PostingRule per role names the GL account, and an admin can change it in
 * Settings → Account assignment. A change applies to postings made after it;
 * posted entries are never rewritten (a reversal copies the entry's own lines).
 */

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" | "OFF_BALANCE";

export type PostingRole = {
  role: string;
  side: "DEBIT" | "CREDIT";
  /** Account types an admin may point this role at. */
  allowedTypes: AccountType[];
  /** Valuation and the month-end close reconcile against this exact account. */
  locked: boolean;
  defaultAccountCode: string;
  label: string;
};

/**
 * Inventory and its clearing accounts. The stock valuation compares the cost
 * pools with 1200 (+ legacy 1230), and the close checks 1210/1220 empty out;
 * pointing a role elsewhere would make both lie without an error.
 */
export const LOCKED_CODES = new Set<string>([
  ACCOUNT.INVENTORY,
  ACCOUNT.INVENTORY_CLEARING_INBOUND,
  ACCOUNT.INVENTORY_CLEARING_OUTBOUND,
  ACCOUNT.INVENTORY_IN_TRANSIT,
]);

const typeOf = (code: string) => {
  const a = CHART_OF_ACCOUNTS.find((x) => x.code === code);
  if (!a) throw new Error(`Posting default ${code} is not in the chart of accounts`);
  return a.accountType as AccountType;
};

function role(
  role: string,
  side: PostingRole["side"],
  defaultAccountCode: string,
  label: string,
  allowedTypes: AccountType[] = [typeOf(defaultAccountCode)]
): PostingRole {
  return { role, side, defaultAccountCode, label, allowedTypes, locked: LOCKED_CODES.has(defaultAccountCode) };
}

/**
 * Transactions with more than one line per side (client's revised mapping,
 * 2026-09-28). Everything else is a debit/credit pair from JOURNAL_TEMPLATES.
 */
const MULTI: Partial<Record<TransactionType, { description: string; roles: PostingRole[] }>> = {
  SALES_INVOICE: {
    description: "Invoice a customer: goods to revenue, tax to transition, shipping to shipping income",
    roles: [
      role("receivable", "DEBIT", ACCOUNT.ACCOUNTS_RECEIVABLE, "Receivable (invoice total)"),
      role("revenue", "CREDIT", ACCOUNT.SALES_REVENUE, "Revenue (goods)"),
      role("salesTax", "CREDIT", ACCOUNT.SALES_TAX_TRANSITION, "Sales tax (until paid)"),
      role("shippingIncome", "CREDIT", ACCOUNT.SHIPPING_INCOME, "Shipping charged"),
    ],
  },
  SALES_RETURN: {
    description: "Credit note: goods back out of revenue, tax share back out of transition",
    roles: [
      role("revenue", "DEBIT", ACCOUNT.SALES_REVENUE, "Revenue (goods returned)"),
      role("salesTax", "DEBIT", ACCOUNT.SALES_TAX_TRANSITION, "Sales tax (share returned)"),
      role("receivable", "CREDIT", ACCOUNT.ACCOUNTS_RECEIVABLE, "Receivable (credit total)"),
    ],
  },
  SALES_TAX_RECOGNIZED: {
    description: "Sales tax collected: transition to payable (cash basis)",
    roles: [
      role("transition", "DEBIT", ACCOUNT.SALES_TAX_TRANSITION, "Sales tax transition"),
      role("payable", "CREDIT", ACCOUNT.SALES_TAX_PAYABLE, "Sales tax payable"),
    ],
  },
  SALES_TAX_UNRECOGNIZED: {
    description: "Sales tax no longer collected (refund, credit, void): payable back to transition",
    roles: [
      role("payable", "DEBIT", ACCOUNT.SALES_TAX_PAYABLE, "Sales tax payable"),
      role("transition", "CREDIT", ACCOUNT.SALES_TAX_TRANSITION, "Sales tax transition"),
    ],
  },
  REVENUE_RECLASS: {
    description: "One-time reclass (2026-09-28): tax and shipping out of historical revenue",
    roles: [
      role("revenue", "DEBIT", ACCOUNT.SALES_REVENUE, "Revenue"),
      role("salesTax", "CREDIT", ACCOUNT.SALES_TAX_TRANSITION, "Sales tax"),
      role("shippingIncome", "CREDIT", ACCOUNT.SHIPPING_INCOME, "Shipping income"),
    ],
  },
};

/** Every transaction type's roles. */
export const POSTING_ROLES = {
  ...Object.fromEntries(
    JOURNAL_TEMPLATES.map((t) => [
      t.transactionType,
      [role("debit", "DEBIT", t.debitAccountCode, "Debit"), role("credit", "CREDIT", t.creditAccountCode, "Credit")],
    ])
  ),
  ...Object.fromEntries(Object.entries(MULTI).map(([type, m]) => [type, m!.roles])),
} as Record<TransactionType, PostingRole[]>;

export function descriptionOf(transactionType: TransactionType) {
  return (
    MULTI[transactionType]?.description ??
    JOURNAL_TEMPLATES.find((t) => t.transactionType === transactionType)?.description ??
    transactionType
  );
}

/** Every transaction type with its roles and the account each is assigned now. */
export async function assignedRoles() {
  const rules = await prisma.postingRule.findMany({ include: { account: true } });
  return Object.entries(POSTING_ROLES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([transactionType, roles]) => ({
      transactionType,
      description: descriptionOf(transactionType as TransactionType),
      roles: roles.map((r) => {
        const rule = rules.find((x) => x.transactionType === transactionType && x.role === r.role);
        if (!rule) throw new ApiError(500, `No account is assigned to ${transactionType}.${r.role}`);
        return { ...r, ruleId: rule.id, account: rule.account };
      }),
    }));
}

/** Boot: a rule for every role that has none, at its default. Never updates one. */
export async function syncPostingRules() {
  const [rules, accounts] = await Promise.all([
    prisma.postingRule.findMany({ select: { transactionType: true, role: true } }),
    prisma.account.findMany({ select: { id: true, code: true } }),
  ]);
  const have = new Set(rules.map((r) => `${r.transactionType}.${r.role}`));
  let inserted = 0;
  for (const [transactionType, roles] of Object.entries(POSTING_ROLES)) {
    for (const r of roles) {
      if (have.has(`${transactionType}.${r.role}`)) continue;
      const account = accounts.find((a) => a.code === r.defaultAccountCode);
      if (!account) throw new Error(`Posting default ${r.defaultAccountCode} missing from the chart`);
      await prisma.postingRule.create({ data: { transactionType, role: r.role, accountId: account.id } });
      inserted++;
    }
  }
  return inserted;
}

/**
 * Post one entry: an amount per role, each on its role's side, to the account
 * the rule names now. Zero amounts post no line; all zero posts nothing.
 */
export async function postRoles(
  tx: Tx,
  input: {
    transactionType: TransactionType;
    amounts: Record<string, number>;
    memo?: string;
    referenceType?: string;
    referenceId?: number;
    actor: string;
    entryDate?: Date;
    productId?: number;
    /** Warehouse to stamp on a role's line, where the old pair did. */
    warehouseIds?: Record<string, number | undefined>;
  }
) {
  const roles = POSTING_ROLES[input.transactionType];
  if (!roles) throw badRequest(`No posting roles for ${input.transactionType}`);
  for (const name of Object.keys(input.amounts)) {
    if (!roles.some((r) => r.role === name)) {
      throw badRequest(`${input.transactionType} has no "${name}" role`);
    }
  }
  const wanted = roles.filter((r) => (input.amounts[r.role] ?? 0) !== 0);
  for (const r of wanted) {
    if (input.amounts[r.role] < 0) throw badRequest(`${input.transactionType}.${r.role}: amount cannot be negative`);
  }
  if (wanted.length === 0) return null;

  const rules = await tx.postingRule.findMany({
    where: { transactionType: input.transactionType },
    include: { account: true },
  });
  const lines: DraftLine[] = wanted.map((r) => {
    const rule = rules.find((x) => x.role === r.role);
    if (!rule) {
      // Never fall back to the code default: that would post somewhere the
      // admin did not choose, silently.
      throw new ApiError(500, `No account is assigned to ${input.transactionType}.${r.role}`);
    }
    const cents = input.amounts[r.role];
    return {
      accountCode: rule.account.code,
      ...(r.side === "DEBIT" ? { debitCents: cents } : { creditCents: cents }),
      productId: input.productId,
      warehouseId: input.warehouseIds?.[r.role],
    };
  });

  return createEntry(tx, {
    transactionType: input.transactionType,
    entryDate: input.entryDate,
    memo: input.memo ?? descriptionOf(input.transactionType),
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    actor: input.actor,
    lines,
  });
}
