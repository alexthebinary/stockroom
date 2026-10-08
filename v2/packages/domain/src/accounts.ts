/**
 * The chart of accounts from the GAAP guide (§III), with one refinement:
 * "Inventory Asset" is a header with two posting children so stock that is
 * billed but still on its way (Inbound) stays apart from stock on the shelf
 * (On Hand). Statements roll the two up and read exactly like the guide; the
 * split is what lets the shelf value reconcile to the ledger to the cent.
 */
export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type Side = "DEBIT" | "CREDIT";

export type AccountDef = {
  code: string;
  name: string;
  type: AccountType;
  normalSide: Side;
  /** A header only sums its children; nothing posts to it. */
  header?: boolean;
  parent?: string;
  purpose: string;
};

export const CHART: AccountDef[] = [
  { code: "1000", name: "Bank / Cash", type: "ASSET", normalSide: "DEBIT", purpose: "Customer receipts, vendor payments and cash refunds" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", normalSide: "DEBIT", purpose: "Amounts due from customers on sales invoices" },
  { code: "1200", name: "Inventory Asset", type: "ASSET", normalSide: "DEBIT", header: true, purpose: "Inventory at average landed cost" },
  { code: "1201", name: "Inventory – On Hand", type: "ASSET", normalSide: "DEBIT", parent: "1200", purpose: "Stock on the shelf, at average landed cost" },
  { code: "1202", name: "Inventory – Inbound", type: "ASSET", normalSide: "DEBIT", parent: "1200", purpose: "Stock billed by the vendor that has not arrived yet" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", normalSide: "CREDIT", purpose: "Vendor bills: inventory, freight-in and freight-out" },
  { code: "2100", name: "Sales Tax Payable", type: "LIABILITY", normalSide: "CREDIT", purpose: "Sales tax collected on products and on shipping & handling" },
  { code: "3000", name: "Opening Balance Equity", type: "EQUITY", normalSide: "CREDIT", purpose: "Offset to the opening inventory balance" },
  { code: "4000", name: "Sales Revenue", type: "INCOME", normalSide: "CREDIT", purpose: "Product sales recognised at invoicing (bill-and-hold)" },
  { code: "4100", name: "Shipping & Handling Revenue", type: "INCOME", normalSide: "CREDIT", purpose: "Shipping & handling charged to customers" },
  { code: "4500", name: "Sales Returns & Allowances", type: "INCOME", normalSide: "DEBIT", purpose: "Product returns and sales price allowances (contra-income)" },
  { code: "4510", name: "Sales Returns & Allowances – Shipping/Handling", type: "INCOME", normalSide: "DEBIT", purpose: "Refunded shipping & handling on full returns (contra-income)" },
  { code: "4900", name: "Inventory Adjustment Gain", type: "INCOME", normalSide: "CREDIT", purpose: "Inventory overage / found stock" },
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", normalSide: "DEBIT", purpose: "Cost of units sold, at average landed cost" },
  { code: "6100", name: "Outbound Shipping Expense", type: "EXPENSE", normalSide: "DEBIT", purpose: "Actual freight-out billed by third-party carriers" },
  { code: "6900", name: "Inventory Adjustment Loss", type: "EXPENSE", normalSide: "DEBIT", purpose: "Inventory shortage / shrinkage" },
];

/**
 * A role is what a posting line MEANS ("the payable"); the account it lands in
 * is data an admin can repoint. Roles are global — repointing `bank` moves
 * every payment and refund together, so the two sides of AP can never drift
 * apart the way per-event rules allowed.
 */
export const ROLES = {
  bank: { label: "Bank / cash account", locked: false },
  payable: { label: "Accounts payable", locked: false },
  inventoryOnHand: { label: "Inventory on hand", locked: true },
  inventoryInbound: { label: "Inventory inbound", locked: true },
  cogs: { label: "Cost of goods sold", locked: false },
  openingEquity: { label: "Opening balance equity", locked: false },
  outboundShipping: { label: "Outbound shipping expense", locked: false },
  returnVariance: { label: "Vendor return variance", locked: false },
  adjustmentGain: { label: "Inventory adjustment gain", locked: false },
  adjustmentLoss: { label: "Inventory adjustment loss", locked: false },
} as const;

export type Role = keyof typeof ROLES;

/**
 * Inventory roles are locked: the books-sound check compares those two
 * accounts to the stock records, and repointing them would break the proof.
 */
export const DEFAULT_ROLE_ACCOUNTS: Record<Role, string> = {
  bank: "1000",
  payable: "2000",
  inventoryOnHand: "1201",
  inventoryInbound: "1202",
  cogs: "5000",
  openingEquity: "3000",
  outboundShipping: "6100",
  returnVariance: "5000",
  adjustmentGain: "4900",
  adjustmentLoss: "6900",
};
