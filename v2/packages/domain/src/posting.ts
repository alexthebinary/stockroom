import { DEFAULT_ROLE_ACCOUNTS, type Role, type Side } from "./accounts";
import { refuse } from "./errors";
import { assertCents, type Cents } from "./money";

/**
 * Every financial event v2 can post, and the side each of its roles takes.
 * Only bills (and, in Phase 2, invoices) and what follows from them post; a
 * purchase order never does (WMS doc).
 *
 * A negative amount flips a line to the other side, so an event whose
 * variance can go either way (a return credited above or below average cost)
 * is still one event.
 */
export const EVENTS = {
  OPENING_STOCK: { label: "Opening stock", sides: { inventoryOnHand: "DEBIT", openingEquity: "CREDIT" }, itemRoles: ["inventoryOnHand"] },
  BILL_POSTED: { label: "Vendor bill – inventory", sides: { inventoryInbound: "DEBIT", payable: "CREDIT" }, itemRoles: [] },
  RECEIPT_LANDED: { label: "Warehouse receipt", sides: { inventoryOnHand: "DEBIT", inventoryInbound: "CREDIT" }, itemRoles: [] },
  FREIGHT_IN_POSTED: {
    label: "Vendor bill – freight-in",
    sides: { inventoryInbound: "DEBIT", inventoryOnHand: "DEBIT", cogs: "DEBIT", payable: "CREDIT" },
    itemRoles: [],
  },
  FREIGHT_OUT_POSTED: { label: "Vendor bill – freight-out", sides: { outboundShipping: "DEBIT", payable: "CREDIT" }, itemRoles: [] },
  VENDOR_PRICE_ALLOWANCE: {
    label: "Vendor price discount",
    sides: { payable: "DEBIT", inventoryInbound: "CREDIT", inventoryOnHand: "CREDIT", cogs: "CREDIT" },
    itemRoles: [],
  },
  PURCHASE_RETURN: {
    label: "Purchase return",
    sides: { payable: "DEBIT", inventoryOnHand: "CREDIT", inventoryInbound: "CREDIT", returnVariance: "CREDIT" },
    itemRoles: [],
  },
  BILL_PAYMENT: { label: "Vendor payment", sides: { payable: "DEBIT", bank: "CREDIT" }, itemRoles: [] },
  VENDOR_REFUND: { label: "Vendor refund", sides: { bank: "DEBIT", payable: "CREDIT" }, itemRoles: [] },
} as const satisfies Record<string, { label: string; sides: Partial<Record<Role, Side>>; itemRoles: readonly Role[] }>;

export type EventType = keyof typeof EVENTS;

export type Dimensions = { itemId?: number; vendorId?: number; poLineId?: number };
export type AmountLine = Dimensions & { role: Role; amountCents: Cents; memo?: string };
export type PlannedLine = Dimensions & { role: Role; side: Side; amountCents: Cents; memo?: string };

const flip = (side: Side): Side => (side === "DEBIT" ? "CREDIT" : "DEBIT");

/** Turn role amounts into balanced, one-sided journal lines, or refuse. */
export function planEntry(event: EventType, amounts: AmountLine[]): PlannedLine[] {
  const definition = EVENTS[event];
  const sides = definition.sides as Partial<Record<Role, Side>>;
  const lines: PlannedLine[] = [];
  for (const { role, amountCents, ...rest } of amounts) {
    const side = sides[role];
    if (!side) throw refuse(`${definition.label} does not use the ${role} role`);
    assertCents(amountCents, `${role} amount`);
    if (amountCents === 0) continue;
    if ((definition.itemRoles as readonly Role[]).includes(role) && rest.itemId == null) {
      throw refuse(`${definition.label}: every ${role} line must name its item`);
    }
    lines.push({ role, side: amountCents > 0 ? side : flip(side), amountCents: Math.abs(amountCents), ...rest });
  }
  assertBalanced(lines, definition.label);
  return lines;
}

export function assertBalanced(lines: { side: Side; amountCents: Cents }[], label = "Entry") {
  const debits = lines.filter((l) => l.side === "DEBIT").reduce((s, l) => s + l.amountCents, 0);
  const credits = lines.filter((l) => l.side === "CREDIT").reduce((s, l) => s + l.amountCents, 0);
  if (debits !== credits) throw refuse(`${label} does not balance: debits ${debits} ≠ credits ${credits}`);
  if (debits === 0) throw refuse(`${label} has nothing to post`);
}

export { DEFAULT_ROLE_ACCOUNTS };
