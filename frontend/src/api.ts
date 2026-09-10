/** Thin fetch wrapper. The dev server proxies /api to the backend. */

const DEMO_USER_KEY = "inventory-demo-user";

export type Paginated<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Money = number; // integer cents

export type ProductCategory = {
  id: number;
  name: string;
  parentId: number | null;
  isActive: boolean;
  children?: ProductCategory[];
  _count?: { products: number };
};

export type Party = {
  id: number;
  name: string;
  email: string | null;
  phone?: string | null;
  address?: string | null;
  role?: string;
  isActive: boolean;
};

export type Account = {
  id: number;
  code: string;
  name: string;
  accountType: string;
  normalSide: string;
};

export type JournalLine = {
  id: number;
  accountId: number;
  debitCents: number;
  creditCents: number;
  memo: string | null;
  account?: Account;
};

export type JournalEntry = {
  id: number;
  entryNumber: string;
  transactionType: string;
  entryDate: string;
  memo: string | null;
  status: string;
  postedAt: string | null;
  referenceType: string | null;
  referenceId: number | null;
  actor: string;
  lines: JournalLine[];
  totalDebitCents?: number;
  totalCreditCents?: number;
};

export type TrialBalance = {
  asOf: string | null;
  accounts: {
    code: string;
    name: string;
    accountType: string;
    normalSide: string;
    debitCents: number;
    creditCents: number;
    balanceCents: number;
  }[];
  totalDebitCents: number;
  totalCreditCents: number;
  entryCount: number;
  /** Entries that do not balance on their own — should always be empty. */
  unbalancedEntries: {
    id: number;
    entryNumber: string;
    debitCents: number;
    creditCents: number;
  }[];
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  incomeCents: number;
  expensesCents: number;
  /**
   * Assets - (Liabilities + Equity + Income - Expenses). Informational only:
   * it is algebraically the same number as totalDebits - totalCredits, so it
   * cannot fail on its own.
   */
  equationVarianceCents: number;
  chartInconsistencies: {
    code: string;
    name: string;
    accountType: string;
    normalSide: string;
    expectedSide: string;
  }[];
  orphanedReversals: { entryNumber: string; transactionType: string }[];
  /** True only when the three checks that can actually fail all pass. */
  sound: boolean;
  balanced: boolean;
};

export type InventoryLot = {
  id: number;
  productId: number;
  warehouseId: number;
  unitCostCents: number;
  originalQty: number;
  remainingQty: number;
  consumedQty: number;
  remainingValueCents: number;
  receivedAt: string;
  sourceType: string;
  product?: Product;
  warehouse?: Warehouse;
};

export type Product = {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  categoryId: number | null;
  defaultCostCents: number;
  defaultPriceCents: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  totalOnHand?: number;
  totalReserved?: number;
  totalIncoming?: number;
  totalAvailable?: number;
};

export type Warehouse = {
  id: number;
  name: string;
  code: string;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  skuCount?: number;
  totalOnHand?: number;
  totalReserved?: number;
  totalIncoming?: number;
};

export type Balance = {
  id: number;
  productId: number;
  warehouseId: number;
  onHandQty: number;
  reservedQty: number;
  incomingQty: number;
  availableQty: number;
  reorderPoint: number;
  lastUpdatedAt: string;
  product?: Product;
  warehouse?: Warehouse;
};

export type SalesReport = {
  groupBy: string;
  orderCount: number;
  /** Goods value only, so the groups sum to it. */
  revenueCents: number;
  taxAndShippingCents: number;
  cogsCents: number;
  grossProfitCents: number;
  groups: { label: string; totalCents: number; count: number }[];
};

export type PurchaseReport = {
  groupBy: string;
  orderCount: number;
  spendCents: number;
  groups: { label: string; totalCents: number; count: number }[];
};

export type StockOnHandReport = {
  asOf: string;
  movementsReplayed: number;
  rows: {
    sku: string;
    productName: string;
    warehouseCode: string;
    quantity: number;
    costCents: number;
  }[];
  totalQuantity: number;
  totalCostCents: number;
};

export type ValuationReport = {
  rows: {
    sku: string;
    name: string;
    warehouseCode: string;
    quantity: number;
    valueCents: number;
    layers: number;
  }[];
  layerValueCents: number;
  /** Stock that has left one warehouse and not yet arrived at the other. */
  inTransitCents: number;
  /** layerValueCents + inTransitCents — what the ledger should agree with. */
  assetValueCents: number;
  ledgerValueCents: number;
  varianceCents: number;
  reconciled: boolean;
};

export type LotConsumption = {
  id: number;
  lotId: number;
  quantity: number;
  unitCostCents: number;
  movementId: number | null;
};

export type SystemMeta = {
  database: string;
  /** Read from the schema file; null if it could not be read. */
  tableCount: number | null;
  groups: {
    name: string;
    blurb: string;
    entities: { name: string; rows: number; note?: string }[];
  }[];
  vocabularies: Record<string, readonly string[]>;
};

export type Movement = {
  id: number;
  productId: number;
  fromWarehouseId: number | null;
  toWarehouseId: number | null;
  quantity: number;
  movementType: string;
  reason: string | null;
  referenceType: string | null;
  referenceId: number | null;
  totalCostCents: number;
  actor: string;
  createdAt: string;
  product?: Product;
  fromWarehouse?: Warehouse | null;
  toWarehouse?: Warehouse | null;
};

export type OrderLine = {
  id: number;
  productId: number;
  warehouseId: number;
  quantity: number;
  unitPriceCents?: number;
  unitCostCents?: number;
  lineTotalCents?: number;
  status: string;
  product?: Product;
  warehouse?: Warehouse;
};

export type SalesOrder = {
  id: number;
  orderNumber: string;
  customerId: number | null;
  customerName: string;
  employeeId: number | null;
  /** Two independent axes, per the scope. */
  readinessStatus: string;
  paymentStatus: string;
  channel: string;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  createdAt: string;
  lines: OrderLine[];
  customer?: Party | null;
  employee?: Party | null;
  invoices?: { id: number; invoiceNumber: string; totalCents: number; status: string }[];
  shipments?: { id: number; shipmentNumber: string; cogsCents: number; status: string }[];
  totalQuantity?: number;
  lineCount?: number;
};

export type PurchaseOrder = {
  id: number;
  poNumber: string;
  vendorId: number | null;
  supplierName: string;
  employeeId: number | null;
  /** SAVED -> POSTED -> PAID -> DELIVERED, or CANCELED. */
  status: string;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  createdAt: string;
  lines: OrderLine[];
  vendor?: Party | null;
  employee?: Party | null;
  bills?: { id: number; billNumber: string; totalCents: number; status: string }[];
  goodsReceipts?: { id: number; grnNumber: string; totalCostCents: number; status: string }[];
  totalQuantity?: number;
  lineCount?: number;
};

export type Adjustment = {
  id: number;
  productId: number;
  warehouseId: number;
  adjustmentType: "INCREASE" | "DECREASE";
  quantity: number;
  reason: string;
  totalCostCents?: number;
  actor: string;
  createdAt: string;
  product?: Product;
  warehouse?: Warehouse;
};

export type Transfer = {
  costCents: number;
  id: number;
  productId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  quantity: number;
  status: string;
  notes: string | null;
  actor: string;
  createdAt: string;
  product?: Product;
  fromWarehouse?: Warehouse;
  toWarehouse?: Warehouse;
};

export type DashboardSummary = {
  lowStockThreshold: number;
  totals: {
    productCount: number;
    activeProductCount: number;
    warehouseCount: number;
    onHandUnits: number;
    reservedUnits: number;
    incomingUnits: number;
    availableUnits: number;
    openSalesOrders: number;
    openPurchaseOrders: number;
    transfersInTransit: number;
  };
  lowStock: Balance[];
  recentMovements: Movement[];
};

/** Surfaces the backend's `error` string so forms can show a real message. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

function currentUserEmail(): string {
  try {
    const raw = localStorage.getItem(DEMO_USER_KEY);
    if (!raw) return "demo@user.com";
    return (JSON.parse(raw).email as string) ?? "demo@user.com";
  } catch {
    return "demo@user.com";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Demo-User": currentUserEmail(),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? res.statusText, body?.details);
  }
  return body as T;
}

/** Drops empty/undefined params so the URL stays readable. */
export function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export { DEMO_USER_KEY };
