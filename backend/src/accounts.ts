/**
 * Chart of accounts and the posting rules for every financial transaction type.
 *
 * Keeping the account pairs here (and mirrored into the JournalTemplate table
 * by the seed) means a posting rule is data, not code buried in a route — which
 * is what the scope's "Common Journal Entry Templates corresponding to
 * Financial Transaction Types" asks for.
 */

export const ACCOUNT = {
  BANK: "1000",
  ACCOUNTS_RECEIVABLE: "1100",
  INVENTORY: "1200",
  INVENTORY_IN_TRANSIT: "1210",
  PREPAID_INVENTORY: "1250",
  ACCOUNTS_PAYABLE: "2000",
  OPENING_BALANCE_EQUITY: "3000",
  SALES_REVENUE: "4000",
  INVENTORY_GAIN: "4900",
  COGS: "5000",
  INVENTORY_SHRINKAGE: "5100",
  ROUNDING_VARIANCE: "5200",
} as const;

export const CHART_OF_ACCOUNTS = [
  { code: ACCOUNT.BANK, name: "Bank / Cash", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.ACCOUNTS_RECEIVABLE, name: "Accounts Receivable", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY, name: "Inventory", accountType: "ASSET", normalSide: "DEBIT" },
  // Stock that has left one warehouse and not yet arrived at the other. It is
  // owned, but it cannot be picked, so it is not Inventory either.
  { code: ACCOUNT.INVENTORY_IN_TRANSIT, name: "Inventory In Transit", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.PREPAID_INVENTORY, name: "Prepaid Inventory", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.ACCOUNTS_PAYABLE, name: "Accounts Payable", accountType: "LIABILITY", normalSide: "CREDIT" },
  // Where stock that existed before the books did comes from. Opening stock is
  // not income: booking it to Inventory Gain overstates revenue by the whole
  // opening position and shows a period with sales and no cost.
  { code: ACCOUNT.OPENING_BALANCE_EQUITY, name: "Opening Balance Equity", accountType: "EQUITY", normalSide: "CREDIT" },
  { code: ACCOUNT.SALES_REVENUE, name: "Sales Revenue", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.INVENTORY_GAIN, name: "Inventory Gain", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.COGS, name: "Cost of Goods Sold", accountType: "EXPENSE", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY_SHRINKAGE, name: "Inventory Shrinkage", accountType: "EXPENSE", normalSide: "DEBIT" },
  // Reported inside cost of sales rather than as an operating expense: it
  // originates in the purchase cost of goods, so it belongs in gross margin.
  // An operating-expense line would imply a cost of running the business.
  { code: ACCOUNT.ROUNDING_VARIANCE, name: "Rounding Variance", accountType: "EXPENSE", normalSide: "DEBIT" },
];

/** Financial transaction types — every one of these posts to the ledger. */
export const TRANSACTION_TYPE = {
  SALES_INVOICE: "SALES_INVOICE",
  SALES_PAYMENT: "SALES_PAYMENT",
  SALES_SHIPMENT_COGS: "SALES_SHIPMENT_COGS",
  PURCHASE_BILL: "PURCHASE_BILL",
  PURCHASE_PAYMENT: "PURCHASE_PAYMENT",
  GOODS_RECEIPT: "GOODS_RECEIPT",
  OPENING_BALANCE: "OPENING_BALANCE",
  INVENTORY_TRANSFER: "INVENTORY_TRANSFER",
  INVENTORY_TRANSFER_IN: "INVENTORY_TRANSFER_IN",
  ADJUSTMENT_INCREASE: "ADJUSTMENT_INCREASE",
  ADJUSTMENT_DECREASE: "ADJUSTMENT_DECREASE",
} as const;

export type TransactionType = (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

/**
 * The debit/credit pair for each type. The three purchase rows are taken
 * verbatim from the scope's purchase-order table.
 */
export const JOURNAL_TEMPLATES: {
  transactionType: TransactionType;
  description: string;
  debitAccountCode: string;
  creditAccountCode: string;
}[] = [
  {
    transactionType: TRANSACTION_TYPE.SALES_INVOICE,
    description: "Invoice a customer",
    debitAccountCode: ACCOUNT.ACCOUNTS_RECEIVABLE,
    creditAccountCode: ACCOUNT.SALES_REVENUE,
  },
  {
    transactionType: TRANSACTION_TYPE.SALES_PAYMENT,
    description: "Receive payment from a customer",
    debitAccountCode: ACCOUNT.BANK,
    creditAccountCode: ACCOUNT.ACCOUNTS_RECEIVABLE,
  },
  {
    transactionType: TRANSACTION_TYPE.SALES_SHIPMENT_COGS,
    description: "Recognise cost of goods sold on shipment (FIFO)",
    debitAccountCode: ACCOUNT.COGS,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    transactionType: TRANSACTION_TYPE.PURCHASE_BILL,
    description: "Post a vendor bill",
    debitAccountCode: ACCOUNT.PREPAID_INVENTORY,
    creditAccountCode: ACCOUNT.ACCOUNTS_PAYABLE,
  },
  {
    transactionType: TRANSACTION_TYPE.PURCHASE_PAYMENT,
    description: "Pay a vendor",
    debitAccountCode: ACCOUNT.ACCOUNTS_PAYABLE,
    creditAccountCode: ACCOUNT.BANK,
  },
  {
    transactionType: TRANSACTION_TYPE.GOODS_RECEIPT,
    description: "Receive goods against a purchase order",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.PREPAID_INVENTORY,
  },
  {
    transactionType: TRANSACTION_TYPE.OPENING_BALANCE,
    description: "Bring stock onto the books at go-live",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.OPENING_BALANCE_EQUITY,
  },
  {
    // Despatch. The destination has not received anything yet, so debiting its
    // Inventory at this point claims stock nobody can pick.
    transactionType: TRANSACTION_TYPE.INVENTORY_TRANSFER,
    description: "Despatch stock from a warehouse into transit",
    debitAccountCode: ACCOUNT.INVENTORY_IN_TRANSIT,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    transactionType: TRANSACTION_TYPE.INVENTORY_TRANSFER_IN,
    description: "Receive stock out of transit into a warehouse",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.INVENTORY_IN_TRANSIT,
  },
  {
    transactionType: TRANSACTION_TYPE.ADJUSTMENT_INCREASE,
    description: "Write stock on at cost",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.INVENTORY_GAIN,
  },
  {
    transactionType: TRANSACTION_TYPE.ADJUSTMENT_DECREASE,
    description: "Write stock off at FIFO cost",
    debitAccountCode: ACCOUNT.INVENTORY_SHRINKAGE,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
];

/**
 * Make the stored chart match this file.
 *
 * The chart was only ever written by the seed, and the seed runs only on an
 * EMPTY database — so every account added after a deployment was created never
 * reached it, and the first posting that referenced one failed with "not in the
 * chart of accounts". That is not hypothetical: 5200 Rounding Variance was
 * added on 2026-09-10 and was still missing from the live database four days
 * later, which would have failed any goods receipt whose landed-cost
 * allocation left a remainder.
 *
 * Running this at boot fixes the whole class rather than each instance. It only
 * ever inserts: renaming or retyping an existing account is a migration with
 * consequences for history, not something a boot step should do silently.
 */
export async function syncChartOfAccounts() {
  const { prisma } = await import("./db");
  const existing = new Set((await prisma.account.findMany({ select: { code: true } })).map((a) => a.code));
  const missing = CHART_OF_ACCOUNTS.filter((a) => !existing.has(a.code));
  if (missing.length === 0) return [];
  await prisma.account.createMany({ data: missing });
  return missing.map((a) => `${a.code} ${a.name}`);
}

/** The expense accounts that belong inside gross margin, not below it. */
export const COGS_ACCOUNT_CODES: string[] = [
  ACCOUNT.COGS,
  ACCOUNT.INVENTORY_SHRINKAGE,
  ACCOUNT.ROUNDING_VARIANCE,
];

export const ENTRY_STATUSES = ["SAVED", "POSTED", "VOID"] as const;
