import { conflict } from "./errors";

/**
 * The WMS doc gives a purchase order four statuses — created, billed,
 * paid/unpaid, received/partially received — that move independently. One
 * status column cannot hold them (a paid order that has not arrived and an
 * unpaid one that has would collide), so they are three axes, each derived
 * from the documents underneath and never set by hand.
 */
export type BillingStatus = "NOT_BILLED" | "DRAFT" | "BILLED";
export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID";
export type ReceivingStatus = "NOT_RECEIVED" | "PARTIAL" | "RECEIVED";
export type ReceiptState = "PENDING_BILL" | "PARTIAL" | "POSTED";

export function billingStatus(bills: { status: string }[]): BillingStatus {
  if (bills.some((b) => b.status === "POSTED")) return "BILLED";
  if (bills.some((b) => b.status === "DRAFT")) return "DRAFT";
  return "NOT_BILLED";
}

export function paymentStatus(owedCents: number, paidCents: number): PaymentStatus {
  if (owedCents <= 0 || paidCents <= 0) return "UNPAID";
  return paidCents >= owedCents ? "PAID" : "PARTIAL";
}

/** Physical arrival, held units included: "received" is about the dock, not the books. */
export function receivingStatus(lines: { qtyOrdered: number; qtyReceived: number }[]): ReceivingStatus {
  const received = lines.reduce((s, l) => s + l.qtyReceived, 0);
  if (received === 0) return "NOT_RECEIVED";
  return lines.every((l) => l.qtyReceived >= l.qtyOrdered) ? "RECEIVED" : "PARTIAL";
}

/** A receipt is posted once every unit on it has landed against a bill. */
export function receiptState(lines: { qty: number; landedQty: number }[]): ReceiptState {
  const landed = lines.reduce((s, l) => s + l.landedQty, 0);
  if (landed === 0) return "PENDING_BILL";
  return lines.every((l) => l.landedQty >= l.qty) ? "POSTED" : "PARTIAL";
}

export const MACHINES = {
  bill: { DRAFT: ["POSTED", "VOID"], POSTED: ["VOID"], VOID: [] },
  scanSession: { OPEN: ["SUBMITTED", "ABANDONED"], SUBMITTED: [], ABANDONED: [] },
  poLifecycle: { OPEN: ["CLOSED", "CANCELED"], CLOSED: ["OPEN"], CANCELED: [] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type Machine = keyof typeof MACHINES;

/** Refuses an illegal move with a 409: the document is not where the caller thought it was. */
export function assertTransition(machine: Machine, from: string, to: string) {
  const allowed = (MACHINES[machine] as Record<string, readonly string[]>)[from] ?? [];
  if (!allowed.includes(to)) throw conflict(`This ${machine} cannot go from ${from} to ${to}`);
}
