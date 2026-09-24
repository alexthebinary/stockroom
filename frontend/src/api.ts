/** Thin fetch wrapper. The dev server proxies /api to the backend. */

const DEMO_USER_KEY = "inventory-demo-user";
const AUTH_TOKEN_KEY = "stockroom-token";
const ACTING_ROLE_KEY = "stockroom-acting-role";

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
  withdrawnEntries: {
    id: number;
    entryNumber: string;
    status: string;
    transactionType: string;
    referenceType: string | null;
  }[];
  /** True only when the four checks that can actually fail all pass. */
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
  /** Purchase lines only: how much has actually arrived. Suppliers under-ship. */
  receivedQty?: number;
  /** Sales lines only: how much has actually left. */
  shippedQty?: number;
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
  shipments?: ShipmentOnOrder[];
  totalQuantity?: number;
  lineCount?: number;
  /** Checkout payments taken before shipment (live ones only). */
  deposits?: { id: number; paymentNumber: string; amountCents: number; invoiceId: number | null }[];
};

/**
 * A shipment as it appears on its own order.
 *
 * `trackingUrl` is derived server-side from carrier + number, so it is null
 * until both exist — not undefined. The UI branches on null.
 */
export type ShipmentOnOrder = {
  id: number;
  shipmentNumber: string;
  cogsCents: number;
  status: string;
  shippedAt: string;
  carrier: string | null;
  trackingNumber: string | null;
  /** Asserted by a person. Stockroom cannot observe a delivery. */
  deliveredAt: string | null;
  trackingUrl: string | null;
  warehouseId: number | null;
};

/**
 * What needs doing, computed server-side so the badge and the page agree.
 *
 * Every figure is derived per request. A stored count of outstanding work is
 * the thing most certain to go stale, and a badge reading "3 to chase" over an
 * empty list is worse than no badge.
 */
export type AttentionJob = {
  id: string;
  severity: "urgent" | "notice";
  title: string;
  detail: string;
  to: string;
  action?: { label: string; to: string };
  amountCents?: number;
};

export type Attention = {
  /** The same facts as named jobs: which one, how bad, what to press. */
  jobs: AttentionJob[];
  invoices: { unpaid: number; overdue: number; outstandingCents: number };
  bills: { unpaid: number; outstandingCents: number };
  deliveries: { inTransit: number };
  receipts: { ordersShort: number };
  stock: { belowReorderPoint: number };
};

/** A row of the cross-order bill list. The inbound mirror of InvoiceRow. */
export type BillRow = {
  id: number;
  billNumber: string;
  issueDate: string;
  currency: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  amountPaidCents: number;
  outstandingCents: number;
  vendorId: number;
  vendor?: Party | null;
  purchaseOrderId: number | null;
  purchaseOrder?: { id: number; poNumber: string; status: string } | null;
};

/** A row of the cross-order goods receipt list. */
export type GoodsReceiptRow = {
  id: number;
  grnNumber: string;
  receivedAt: string;
  status: string;
  /** Landed cost — what the FIFO layers were created at, not order value. */
  totalCostCents: number;
  warehouseId: number | null;
  warehouse?: { id: number; name: string; code: string } | null;
  purchaseOrderId: number;
  purchaseOrder?: { id: number; poNumber: string; supplierName: string; status: string } | null;
  /** The ORDER's current coverage, so a row can say whether it is still short. */
  orderQuantity: number;
  orderReceivedQty: number;
  orderComplete: boolean;
};

/** A row of the cross-order invoice list. */
export type InvoiceRow = {
  id: number;
  invoiceNumber: string;
  issueDate: string;
  currency: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  /** Both computed per request — a reversed payment must change them at once. */
  amountPaidCents: number;
  outstandingCents: number;
  customerId: number;
  customer?: Party | null;
  salesOrderId: number | null;
  salesOrder?: { id: number; orderNumber: string; readinessStatus: string } | null;
};

/** A row of the cross-order delivery list. */
export type DeliveryRow = {
  id: number;
  shipmentNumber: string;
  shippedAt: string;
  status: string;
  cogsCents: number;
  carrier: string | null;
  trackingNumber: string | null;
  deliveredAt: string | null;
  trackingUrl: string | null;
  warehouseId: number | null;
  warehouse?: { id: number; name: string; code: string } | null;
  salesOrderId: number;
  salesOrder?: {
    id: number;
    orderNumber: string;
    customerName: string;
    paymentStatus: string;
  } | null;
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

function actingRole(): string | null {
  try {
    return localStorage.getItem(ACTING_ROLE_KEY);
  } catch {
    return null;
  }
}

function authToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Fired when the server rejects a token we actually sent.
 *
 * A dead token used to leave the app rendering its whole shell with every
 * panel showing "Could not load data — Sign in to use Stockroom", because the
 * user object in localStorage outlived the token beside it. The sign-in form
 * was unreachable without clearing site data by hand. Tokens expire, the API
 * restarts with no AUTH_SECRET locally, and an account can be deactivated —
 * all three land here.
 */
export const SESSION_EXPIRED_EVENT = "stockroom:session-expired";

function abandonSession() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(DEMO_USER_KEY);
    localStorage.removeItem(ACTING_ROLE_KEY);
  } catch {
    /* private browsing: nothing was stored, nothing to clear */
  }
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const sentToken = authToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // The signed token, not a claimed identity. The server reads the actor
      // from this; a header the client fills in is not an audit trail.
      // NOT Authorization: a hosted instance sits behind HTTP Basic, and that
      // header holds one credential — setting Bearer here replaced the Basic
      // one and locked the app out of its own API.
      ...(authToken() ? { "X-Stockroom-Session": authToken()! } : {}),
      // Honoured only for an administrator, and only to REDUCE capability. The
      // server checks both; this header grants nothing on its own.
      ...(actingRole() ? { "X-Act-As-Role": actingRole()! } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    // Only when we PRESENTED a token. A 401 from /auth/login is a wrong
    // password, not an expired session, and clearing state there would wipe a
    // perfectly good session because someone fat-fingered a retry.
    if (res.status === 401 && sentToken) abandonSession();
    throw new ApiError(res.status, body?.error ?? res.statusText, body?.details);
  }
  return body as T;
}

/**
 * Open a server-rendered PDF in a new tab.
 *
 * The API authenticates with a HEADER, and a plain `<a href>` cannot send one,
 * so every PDF link in the app answered 401 once sign-in became real. This
 * fetches with the session, then shows the bytes. The tab is opened BEFORE the
 * await: a window opened after one is no longer a response to the click, and
 * mobile Safari blocks it as a pop-up.
 */
export async function openPdf(path: string) {
  const tab = window.open("", "_blank");
  try {
    const res = await fetch(`/api${path}`, {
      headers: {
        ...(authToken() ? { "X-Stockroom-Session": authToken()! } : {}),
        ...(actingRole() ? { "X-Act-As-Role": actingRole()! } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      let message = res.statusText;
      try {
        message = JSON.parse(text)?.error ?? message;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, message);
    }
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.location.href = url;
    // Long enough for the viewer to load it; the tab keeps its own copy.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
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

export { DEMO_USER_KEY, AUTH_TOKEN_KEY, ACTING_ROLE_KEY };
