import { conflict } from "./errors";

/**
 * The WMS doc gives a purchase order four statuses — created, billed,
 * paid/unpaid, received/partially received — that move independently. One
 * status column cannot hold them (a paid order that has not arrived and an
 * unpaid one that has would collide), so they are three axes, each derived
 * from the documents underneath and never set by hand.
 *
 * Receipt state is the same kind of axis for one warehouse receipt.
 */
export const BILLING_STATUSES = ["NOT_BILLED", "DRAFT", "BILLED"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];
export const PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const RECEIVING_STATUSES = ["NOT_RECEIVED", "PARTIAL", "RECEIVED"] as const;
export type ReceivingStatus = (typeof RECEIVING_STATUSES)[number];
export const RECEIPT_STATES = ["PENDING_BILL", "PARTIAL", "POSTED"] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

export const DERIVED = {
  billingStatus: BILLING_STATUSES,
  paymentStatus: PAYMENT_STATUSES,
  receivingStatus: RECEIVING_STATUSES,
  receiptState: RECEIPT_STATES,
} as const;

function lookup<const T extends readonly string[]>(values: T): { [K in T[number]]: K } {
  return Object.fromEntries(values.map((value) => [value, value])) as { [K in T[number]]: K };
}

/** Derived-axis values for comparisons. Not transition machines. */
export const Axis = {
  billing: lookup(BILLING_STATUSES),
  payment: lookup(PAYMENT_STATUSES),
  receiving: lookup(RECEIVING_STATUSES),
  receipt: lookup(RECEIPT_STATES),
} as const;

export function billingStatus(bills: { status: string }[]): BillingStatus {
  if (bills.some((b) => b.status === "POSTED")) return Axis.billing.BILLED;
  if (bills.some((b) => b.status === "DRAFT")) return Axis.billing.DRAFT;
  return Axis.billing.NOT_BILLED;
}

/**
 * For one posted bill: what is still owed after credits, against what was paid
 * (net of refunds). A bill fully credited back owes nothing and reads PAID —
 * settled. A purchase order with no posted bill is UNPAID; the caller decides
 * that, because there is no bill to ask.
 */
export function paymentStatus(owedCents: number, paidCents: number): PaymentStatus {
  if (owedCents <= 0) return Axis.payment.PAID;
  if (paidCents <= 0) return Axis.payment.UNPAID;
  return paidCents >= owedCents ? Axis.payment.PAID : Axis.payment.PARTIAL;
}

/** Physical arrival, held units included: "received" is about the dock, not the books. */
export function receivingStatus(lines: { qtyOrdered: number; qtyReceived: number }[]): ReceivingStatus {
  const received = lines.reduce((s, l) => s + l.qtyReceived, 0);
  if (received === 0) return Axis.receiving.NOT_RECEIVED;
  return lines.every((l) => l.qtyReceived >= l.qtyOrdered) ? Axis.receiving.RECEIVED : Axis.receiving.PARTIAL;
}

/** A receipt is posted once every unit on it has landed against a bill. */
export function receiptState(lines: { qty: number; landedQty: number }[]): ReceiptState {
  const landed = lines.reduce((s, l) => s + l.landedQty, 0);
  if (landed === 0) return Axis.receipt.PENDING_BILL;
  return lines.every((l) => l.landedQty >= l.qty) ? Axis.receipt.POSTED : Axis.receipt.PARTIAL;
}

/**
 * What the writers do today. `initial` is the column default (a create may
 * also insert another state when that is an entry, not a move). An edge is a
 * move some writer performs, including a self-edge where the same write is
 * allowed to land on the state the row is already in.
 *
 * Purchase-order lifecycle has no CLOSED. Nothing writes it. Cancel is
 * idempotent, so CANCELED stays CANCELED. Migrations do not CHECK these
 * columns; they are plain text.
 */
export const MACHINES = {
  bill: {
    initial: "DRAFT",
    edges: {
      DRAFT: ["POSTED", "VOID"],
      POSTED: ["VOID"],
      VOID: [],
    },
  },
  payment: {
    initial: "POSTED",
    edges: {
      POSTED: ["VOID"],
      VOID: [],
    },
  },
  scanSession: {
    initial: "OPEN",
    edges: {
      // OPEN stays OPEN when the clerk edits vendor, order, notes, or the slip.
      OPEN: ["OPEN", "SUBMITTED", "ABANDONED"],
      SUBMITTED: [],
      ABANDONED: [],
    },
  },
  poLifecycle: {
    initial: "OPEN",
    edges: {
      OPEN: ["CANCELED"],
      CANCELED: ["CANCELED"],
    },
  },
  serialUnit: {
    initial: "HELD",
    edges: {
      HELD: ["IN_STOCK"],
      IN_STOCK: ["HELD", "RETURNED"],
      RETURNED: [],
    },
  },
  feedbackStatus: {
    initial: "OPEN",
    edges: {
      OPEN: ["OPEN", "DONE", "WONTFIX"],
      DONE: ["OPEN", "DONE", "WONTFIX"],
      WONTFIX: ["OPEN", "DONE", "WONTFIX"],
    },
  },
  feedbackSpec: {
    initial: "NONE",
    edges: {
      NONE: ["NONE", "PROPOSED"],
      PROPOSED: ["NONE", "PROPOSED", "CONFIRMED"],
      CONFIRMED: ["NONE", "PROPOSED"],
    },
  },
  feedbackAuto: {
    initial: "NONE",
    edges: {
      NONE: ["QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"],
      QUEUED: ["QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"],
      NEEDS_ANSWER: ["QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"],
      FAILED: ["QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"],
      SHIPPED: ["QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"],
    },
  },
} as const satisfies Record<string, { initial: string; edges: Record<string, readonly string[]> }>;

export type Machine = keyof typeof MACHINES;
export type MachineState<M extends Machine> = keyof (typeof MACHINES)[M]["edges"] & string;
export type BillState = MachineState<"bill">;
export type PaymentState = MachineState<"payment">;
export type ScanSessionState = MachineState<"scanSession">;
export type PoLifecycleState = MachineState<"poLifecycle">;
export type SerialState = MachineState<"serialUnit">;
export type FeedbackStatus = MachineState<"feedbackStatus">;
export type FeedbackSpecState = MachineState<"feedbackSpec">;
export type FeedbackAutoState = MachineState<"feedbackAuto">;

export const BILL_STATES = ["DRAFT", "POSTED", "VOID"] as const satisfies readonly BillState[];
export const PAYMENT_STATES = ["POSTED", "VOID"] as const satisfies readonly PaymentState[];
export const SCAN_STATES = ["OPEN", "SUBMITTED", "ABANDONED"] as const satisfies readonly ScanSessionState[];
export const PO_LIFECYCLE_STATES = ["OPEN", "CANCELED"] as const satisfies readonly PoLifecycleState[];
export const SERIAL_STATES = ["HELD", "IN_STOCK", "RETURNED"] as const satisfies readonly SerialState[];
export const FEEDBACK_STATUSES = ["OPEN", "DONE", "WONTFIX"] as const satisfies readonly FeedbackStatus[];
export const FEEDBACK_SPEC_STATES = ["NONE", "PROPOSED", "CONFIRMED"] as const satisfies readonly FeedbackSpecState[];
export const FEEDBACK_AUTO_STATES = ["NONE", "QUEUED", "NEEDS_ANSWER", "FAILED", "SHIPPED"] as const satisfies readonly FeedbackAutoState[];

/** POST /api/feedback/:id/auto/outcome may set the job to one of these. */
export const FEEDBACK_AUTO_OUTCOMES = ["FAILED", "SHIPPED", "QUEUED"] as const satisfies readonly FeedbackAutoState[];
/** That same call may also set the note to one of these. */
export const FEEDBACK_JOB_STATUSES = ["DONE", "OPEN"] as const satisfies readonly FeedbackStatus[];

/**
 * GET /api/purchase-orders `lifecycle`. ALL means no filter. CLOSED is accepted
 * because the orders screen offers it; the column is matched exactly, and
 * nothing ever writes CLOSED.
 */
export const PO_LIFECYCLE_FILTERS = ["OPEN", "CANCELED", "CLOSED", "ALL"] as const;

/** State literals for writers. The strings live here, not at the call site. */
export const State = {
  bill: lookup(BILL_STATES),
  payment: lookup(PAYMENT_STATES),
  scanSession: lookup(SCAN_STATES),
  poLifecycle: lookup(PO_LIFECYCLE_STATES),
  serialUnit: lookup(SERIAL_STATES),
  feedbackStatus: lookup(FEEDBACK_STATUSES),
  feedbackSpec: lookup(FEEDBACK_SPEC_STATES),
  feedbackAuto: lookup(FEEDBACK_AUTO_STATES),
} as const;

export function sourcesFor<M extends Machine>(machine: M, to: MachineState<M>): MachineState<M>[] {
  const edges = MACHINES[machine].edges as Record<MachineState<M>, readonly MachineState<M>[]>;
  return (Object.keys(edges) as MachineState<M>[]).filter((from) => edges[from].includes(to));
}

/** Default 409 text when a guarded move finds the row in some other state. */
export function refusalMessage(label: string, current: string, allowed: readonly string[]): string {
  const state = current.toLowerCase();
  if (allowed.length === 0) return `${label} is ${state}; it is final`;
  return `${label} is ${state}; it can only go to ${allowed.map((next) => next.toLowerCase()).join(", ")}`;
}

/** Refuses an illegal move with a 409: the document is not where the caller thought it was. */
export function assertTransition(machine: Machine, from: string, to: string) {
  const allowed = (MACHINES[machine].edges as Record<string, readonly string[]>)[from] ?? [];
  if (!allowed.includes(to)) throw conflict(`This ${machine} cannot go from ${from} to ${to}`);
}
