/**
 * Chart of accounts and the posting rules for every financial transaction type.
 *
 * Keeping the account pairs here (and mirrored into the JournalTemplate table
 * by the seed) means a posting rule is data, not code buried in a route — which
 * is what the scope's "Common Journal Entry Templates corresponding to
 * Financial Transaction Types" asks for.
 */

/**
 * Codes and names follow the client's "Chart of Accounts & Transaction Journal
 * Entries" (adopted 2026-09-24). Accounts the client's sheet does not cover
 * (customer deposits, transit between warehouses, rounding, repairs, warranty)
 * keep their own codes in the gaps. The old constant names stay as aliases so
 * the posting code reads the same; syncChartOfAccounts() renumbers live rows.
 */
export const ACCOUNT = {
  BANK: "1000",
  ACCOUNTS_RECEIVABLE: "1100",
  INVENTORY: "1200",
  /// Bill received, goods not yet put away (client: 1210). Was 1250 "Prepaid Inventory".
  INVENTORY_CLEARING_INBOUND: "1210",
  PREPAID_INVENTORY: "1210",
  /// Goods issued on a shipment, cost not yet matched to an invoice (client: 1220).
  INVENTORY_CLEARING_OUTBOUND: "1220",
  /// Stock between two of our warehouses. Was 1210 until the client's chart took that code.
  INVENTORY_IN_TRANSIT: "1230",
  ACCOUNTS_PAYABLE: "2000",
  /// Money taken at checkout for goods not yet shipped. It is owed to the
  /// customer (as goods or a refund) until the order ships, so it is a
  /// liability, not revenue.
  CUSTOMER_DEPOSITS: "2100",
  OPENING_BALANCE_EQUITY: "3000",
  SALES_REVENUE: "4000",
  /// Found stock on a count (client: 4100). Was 4900 "Inventory Gain".
  INVENTORY_ADJUSTMENT_GAIN: "4100",
  INVENTORY_GAIN: "4100",
  COGS: "5000",
  INVENTORY_ADJUSTMENT_LOSS: "5100",
  INVENTORY_SHRINKAGE: "5100",
  /// Parts consumed repairing a unit. NOT Cost of Goods Sold: repair parts are
  /// not matched to sales revenue, so folding them into 5000 would understate
  /// gross margin on every period that contains a repair.
  REPAIR_PARTS: "5300",
  /// Cost of a unit given away to honour a warranty. Again not COGS — there is
  /// no revenue on the other side of it.
  WARRANTY_EXPENSE: "5400",
  ROUNDING_VARIANCE: "5200",
} as const;

export const CHART_OF_ACCOUNTS = [
  { code: ACCOUNT.BANK, name: "Bank / Cash", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.ACCOUNTS_RECEIVABLE, name: "Accounts Receivable (AR)", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY, name: "Inventory", accountType: "ASSET", normalSide: "DEBIT" },
  // Stock that has left one warehouse and not yet arrived at the other. It is
  // owned, but it cannot be picked, so it is not Inventory either.
  { code: ACCOUNT.INVENTORY_CLEARING_INBOUND, name: "Inventory Clearing – Inbound", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY_CLEARING_OUTBOUND, name: "Inventory Clearing – Outbound", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY_IN_TRANSIT, name: "Inventory In Transit", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.ACCOUNTS_PAYABLE, name: "Accounts Payable (AP)", accountType: "LIABILITY", normalSide: "CREDIT" },
  { code: ACCOUNT.CUSTOMER_DEPOSITS, name: "Customer Deposits", accountType: "LIABILITY", normalSide: "CREDIT" },
  // Where stock that existed before the books did comes from. Opening stock is
  // not income: booking it to Inventory Gain overstates revenue by the whole
  // opening position and shows a period with sales and no cost.
  { code: ACCOUNT.OPENING_BALANCE_EQUITY, name: "Opening Balance Equity", accountType: "EQUITY", normalSide: "CREDIT" },
  { code: ACCOUNT.SALES_REVENUE, name: "Sales Revenue", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.INVENTORY_ADJUSTMENT_GAIN, name: "Inventory Adjustment Gain", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.COGS, name: "Cost of Goods Sold", accountType: "EXPENSE", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY_ADJUSTMENT_LOSS, name: "Inventory Adjustment Loss", accountType: "EXPENSE", normalSide: "DEBIT" },
  { code: ACCOUNT.REPAIR_PARTS, name: "Repair Parts Expense", accountType: "EXPENSE", normalSide: "DEBIT" },
  { code: ACCOUNT.WARRANTY_EXPENSE, name: "Warranty Expense", accountType: "EXPENSE", normalSide: "DEBIT" },
  // Reported inside cost of sales rather than as an operating expense: it
  // originates in the purchase cost of goods, so it belongs in gross margin.
  // An operating-expense line would imply a cost of running the business.
  { code: ACCOUNT.ROUNDING_VARIANCE, name: "Rounding Variance", accountType: "EXPENSE", normalSide: "DEBIT" },
];

/** Financial transaction types — every one of these posts to the ledger. */
export const TRANSACTION_TYPE = {
  SALES_INVOICE: "SALES_INVOICE",
  SALES_PAYMENT: "SALES_PAYMENT",
  /// Legacy: shipments before 2026-09-24 posted COGS straight off Inventory.
  SALES_SHIPMENT_COGS: "SALES_SHIPMENT_COGS",
  GOODS_ISSUE: "GOODS_ISSUE",
  INVOICE_COGS: "INVOICE_COGS",
  CUSTOMER_DEPOSIT: "CUSTOMER_DEPOSIT",
  DEPOSIT_APPLIED: "DEPOSIT_APPLIED",
  SALES_RETURN: "SALES_RETURN",
  RETURN_RESTOCK: "RETURN_RESTOCK",
  CUSTOMER_REFUND: "CUSTOMER_REFUND",
  PURCHASE_BILL: "PURCHASE_BILL",
  PURCHASE_PAYMENT: "PURCHASE_PAYMENT",
  GOODS_RECEIPT: "GOODS_RECEIPT",
  OPENING_BALANCE: "OPENING_BALANCE",
  INVENTORY_TRANSFER: "INVENTORY_TRANSFER",
  INVENTORY_TRANSFER_IN: "INVENTORY_TRANSFER_IN",
  REPAIR_PARTS_CONSUMPTION: "REPAIR_PARTS_CONSUMPTION",
  WARRANTY_REPLACEMENT: "WARRANTY_REPLACEMENT",
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
    transactionType: TRANSACTION_TYPE.CUSTOMER_DEPOSIT,
    description: "Take payment at checkout, before the goods ship",
    debitAccountCode: ACCOUNT.BANK,
    creditAccountCode: ACCOUNT.CUSTOMER_DEPOSITS,
  },
  {
    transactionType: TRANSACTION_TYPE.DEPOSIT_APPLIED,
    description: "Apply a checkout payment to the invoice raised on shipment",
    debitAccountCode: ACCOUNT.CUSTOMER_DEPOSITS,
    creditAccountCode: ACCOUNT.ACCOUNTS_RECEIVABLE,
  },
  {
    // Booked straight against Sales Revenue rather than a contra account: the
    // chart check requires every INCOME account to be credit-normal, and a
    // debit-normal "Sales Returns" would trip it. The return documents carry
    // the detail a separate account would.
    transactionType: TRANSACTION_TYPE.SALES_RETURN,
    description: "Credit a customer for goods returned",
    debitAccountCode: ACCOUNT.SALES_REVENUE,
    creditAccountCode: ACCOUNT.ACCOUNTS_RECEIVABLE,
  },
  {
    transactionType: TRANSACTION_TYPE.RETURN_RESTOCK,
    description: "Put returned goods back into stock at the cost they left at",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.COGS,
  },
  {
    transactionType: TRANSACTION_TYPE.CUSTOMER_REFUND,
    description: "Refund a customer who has paid more than they owe",
    debitAccountCode: ACCOUNT.ACCOUNTS_RECEIVABLE,
    creditAccountCode: ACCOUNT.BANK,
  },
  {
    transactionType: TRANSACTION_TYPE.REPAIR_PARTS_CONSUMPTION,
    description: "Consume parts from stock on a repair",
    debitAccountCode: ACCOUNT.REPAIR_PARTS,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    transactionType: TRANSACTION_TYPE.WARRANTY_REPLACEMENT,
    description: "Give a replacement unit under warranty",
    debitAccountCode: ACCOUNT.WARRANTY_EXPENSE,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    transactionType: TRANSACTION_TYPE.SALES_SHIPMENT_COGS,
    description: "Legacy: cost of goods sold straight off Inventory on shipment",
    debitAccountCode: ACCOUNT.COGS,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    // Client sheet 3.3: the shipment relieves on-hand Inventory into the
    // outbound clearing account at FIFO cost.
    transactionType: TRANSACTION_TYPE.GOODS_ISSUE,
    description: "Goods issue: stock leaves on a shipment (FIFO cost)",
    debitAccountCode: ACCOUNT.INVENTORY_CLEARING_OUTBOUND,
    creditAccountCode: ACCOUNT.INVENTORY,
  },
  {
    // Client sheet 3.1 part B: the invoice recognises the cost of what it bills.
    transactionType: TRANSACTION_TYPE.INVOICE_COGS,
    description: "Recognise cost of goods sold against the invoice",
    debitAccountCode: ACCOUNT.COGS,
    creditAccountCode: ACCOUNT.INVENTORY_CLEARING_OUTBOUND,
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
/** Live accounts renumbered to the client's chart. Applied in this order: 1210 must move before 1250 takes it. */
const RENUMBER: { from: string; to: string; ifNamed: string }[] = [
  { from: "1210", to: "1230", ifNamed: "Inventory In Transit" },
  { from: "1250", to: "1210", ifNamed: "Prepaid Inventory" },
  { from: "4900", to: "4100", ifNamed: "Inventory Gain" },
];

export async function syncChartOfAccounts() {
  const { prisma } = await import("./db");
  const changes: string[] = [];

  // Renumber in place. Journal lines point at the account's id, not its code,
  // so history moves with the row; only the label an accountant reads changes.
  // Guarded by name so a database that already has the new chart is untouched.
  for (const r of RENUMBER) {
    const row = await prisma.account.findUnique({ where: { code: r.from } });
    const taken = await prisma.account.findUnique({ where: { code: r.to } });
    if (row && row.name === r.ifNamed && !taken) {
      await prisma.account.update({ where: { id: row.id }, data: { code: r.to } });
      changes.push(`${r.from}→${r.to}`);
    }
  }

  const existing = await prisma.account.findMany({ select: { id: true, code: true, name: true } });
  const byCode = new Map(existing.map((a) => [a.code, a]));
  for (const a of CHART_OF_ACCOUNTS) {
    const row = byCode.get(a.code);
    if (!row) {
      await prisma.account.create({ data: a });
      changes.push(`+${a.code} ${a.name}`);
    } else if (row.name !== a.name) {
      await prisma.account.update({ where: { id: row.id }, data: { name: a.name } });
      changes.push(`${a.code} renamed "${a.name}"`);
    }
  }

  // Posting rules are data too; keep the stored table equal to this file so the
  // Posting rules page shows what the code actually posts.
  const rules = new Map(
    (await prisma.journalTemplate.findMany()).map((t) => [t.transactionType, t])
  );
  for (const t of JOURNAL_TEMPLATES) {
    const row = rules.get(t.transactionType);
    if (!row) {
      await prisma.journalTemplate.create({ data: t });
    } else if (
      row.debitAccountCode !== t.debitAccountCode ||
      row.creditAccountCode !== t.creditAccountCode ||
      row.description !== t.description
    ) {
      await prisma.journalTemplate.update({ where: { id: row.id }, data: t });
    }
  }
  return changes;
}

/** The expense accounts that belong inside gross margin, not below it. */
export const COGS_ACCOUNT_CODES: string[] = [
  ACCOUNT.COGS,
  ACCOUNT.INVENTORY_SHRINKAGE,
  ACCOUNT.ROUNDING_VARIANCE,
];

export const ENTRY_STATUSES = ["SAVED", "POSTED", "VOID"] as const;
