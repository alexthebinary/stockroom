export type Warehouse = { id: number; code: string; name: string; isSample: boolean };
export type Vendor = { id: number; name: string; kind: "SUPPLIER" | "CARRIER"; email: string | null; phone: string | null; paymentTermsDays: number; isSample: boolean };
export type Barcode = { id: number; code: string; raw: string; packQty: number };
export type Item = {
  id: number;
  sku: string;
  name: string;
  trackingMode: "NONE" | "SERIAL";
  condition: string;
  conditionOfId: number | null;
  defaultVendorId: number | null;
  lastCostCents: number;
  barcodes?: Barcode[];
};

export type PoLine = {
  id: number;
  itemId: number;
  qtyOrdered: number;
  unitCostCents: number;
  qtyReceived: number;
  qtyHeld: number;
  qtyLanded: number;
  qtyBilled: number;
  qtyReturned: number;
  inboundCents: number;
  addedAtDock: boolean;
  item?: Item;
};

export type PurchaseOrder = {
  id: number;
  number: string;
  vendorId: number | null;
  vendor?: Vendor | null;
  warehouseId: number;
  source: "MANUAL" | "SCAN";
  lifecycle: string;
  billingStatus: "NOT_BILLED" | "DRAFT" | "BILLED";
  paymentStatus: "UNPAID" | "PARTIAL" | "PAID";
  receivingStatus: "NOT_RECEIVED" | "PARTIAL" | "RECEIVED";
  notes: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  lines: PoLine[];
  heldUnits?: number;
  totalEstimateCents?: number;
};

export type BillLine = {
  id: number;
  poLineId: number | null;
  itemId: number | null;
  description: string | null;
  qty: number;
  unitCostCents: number;
  discountCents: number;
  amountCents: number;
  freightCents: number;
  landedCents: number;
  item?: Item;
  poLine?: PoLine | null;
};

export type Bill = {
  id: number;
  number: string;
  kind: "INVENTORY" | "FREIGHT_IN" | "FREIGHT_OUT";
  status: "DRAFT" | "POSTED" | "VOID";
  source: "SCAN" | "MANUAL";
  vendorId: number | null;
  vendor?: Vendor | null;
  poId: number | null;
  po?: PurchaseOrder | null;
  vendorInvoiceNumber: string | null;
  billDate: string;
  termsDays: number;
  dueDate: string;
  freightCents: number;
  allocationBasis: "VALUE" | "QTY";
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  openCents?: number;
  heldUnits?: number;
  notes: string | null;
  attachment: string | boolean | null;
  targetPoIds: number[];
  version: number;
  createdAt: string;
  postedAt: string | null;
  postedBy: string | null;
  lines: BillLine[];
};

export type ScanEvent = {
  id: number;
  clientId: string;
  code: string | null;
  itemId: number | null;
  qty: number;
  serial: string | null;
  unknownName: string | null;
  needsReview: boolean;
};

export type Setup = {
  company: { name: string; address: string | null; homeState: string | null; fiscalYearStartMonth: number; setupStep: number; setupCompletedAt: string | null; sampleDataLoadedAt: string | null; feedbackEnabled: boolean };
  required: boolean;
  counts: { profiles: number; warehouses: number; vendors: number; items: number; stocked: number };
  sample: {
    loaded: boolean;
    canClear: boolean;
    widget: { sku: string; name: string; barcode: string; vendorSku: string; costCents: number };
    robot: { sku: string; name: string; barcode: string; vendorSku: string; costCents: number };
    openBox: { sku: string; name: string; barcode: string };
    serials: string[];
    supplier: { name: string };
    carrier: { name: string };
  };
};

export type Home = {
  clerk: { openDeliveries: number; expectedOrders: number };
  accounting: { draftBills: number; heldUnits: number; unknownItems: number; payableCents: number; dueThisWeekCents: number; overdueCents: number };
  admin: { booksSound: boolean; problems: string[] };
};
