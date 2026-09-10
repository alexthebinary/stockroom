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
  PREPAID_INVENTORY: "1250",
  ACCOUNTS_PAYABLE: "2000",
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
  { code: ACCOUNT.PREPAID_INVENTORY, name: "Prepaid Inventory", accountType: "ASSET", normalSide: "DEBIT" },
  { code: ACCOUNT.ACCOUNTS_PAYABLE, name: "Accounts Payable", accountType: "LIABILITY", normalSide: "CREDIT" },
  { code: ACCOUNT.SALES_REVENUE, name: "Sales Revenue", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.INVENTORY_GAIN, name: "Inventory Gain", accountType: "INCOME", normalSide: "CREDIT" },
  { code: ACCOUNT.COGS, name: "Cost of Goods Sold", accountType: "EXPENSE", normalSide: "DEBIT" },
  { code: ACCOUNT.INVENTORY_SHRINKAGE, name: "Inventory Shrinkage", accountType: "EXPENSE", normalSide: "DEBIT" },
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
  INVENTORY_TRANSFER: "INVENTORY_TRANSFER",
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
    transactionType: TRANSACTION_TYPE.INVENTORY_TRANSFER,
    description: "Move stock between warehouses at carrying cost",
    debitAccountCode: ACCOUNT.INVENTORY,
    creditAccountCode: ACCOUNT.INVENTORY,
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

export const ENTRY_STATUSES = ["SAVED", "POSTED", "VOID"] as const;
