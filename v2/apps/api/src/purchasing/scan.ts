import { DomainError } from "@pi/domain";
import type { Tx } from "../db";
import { Prisma } from "../db";
import { addBarcode, lookupCode } from "../catalog";
import type { StockCtx } from "../stock";
import { type Arrival, receive } from "./receive";

export type IncomingEvent = {
  clientId: string;
  code?: string | null;
  itemId?: number | null;
  qty: number;
  source: "BARCODE" | "AI" | "MANUAL";
  serial?: string | null;
  unknownName?: string | null;
  photo?: string | null;
  capturedAt: Date;
};

export type SlipRead = { vendorName?: string | null; poNumber?: string | null; lines?: { itemId?: number | null; unitPriceCents?: number | null }[] };

/**
 * Append scan events. Each carries a device-made UUID, so a phone that loses
 * signal and resends a batch adds nothing twice. A code is matched to an item
 * here (barcode → this vendor's item number → SKU); a case barcode multiplies
 * by its pack quantity; a GS1 label's serial is captured. Unmatched codes are
 * kept as unknowns for someone to map later — they never block the clerk.
 */
export async function appendEvents(tx: Tx, sessionId: number, events: IncomingEvent[]) {
  const session = await tx.scanSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (session.status !== "OPEN") throw new DomainError("This delivery was already finished; start a new one to scan more", 409);
  const keys = events.map((e) => e.clientId);
  const known = new Set((await tx.scanEvent.findMany({ where: { clientId: { in: keys } }, select: { clientId: true } })).map((e) => e.clientId));
  for (const event of events) {
    if (known.has(event.clientId)) continue;
    let itemId = event.itemId ?? null;
    let qty = event.qty;
    let serial = event.serial?.trim() || null;
    if (!itemId && event.code) {
      const match = await lookupCode(tx, event.code, session.vendorId);
      if (match) {
        itemId = match.itemId;
        qty = event.qty * match.packQty;
        serial ??= match.serial ?? null;
      }
    }
    const item = itemId ? await tx.item.findUnique({ where: { id: itemId } }) : null;
    const needsReview = !item || (item.trackingMode === "SERIAL" && qty > 0 && !serial);
    await tx.scanEvent.create({
      data: {
        sessionId,
        clientId: event.clientId,
        code: event.code,
        itemId: item?.id ?? null,
        qty,
        source: event.source,
        serial,
        unknownName: item ? null : event.unknownName,
        photo: event.photo,
        needsReview,
        capturedAt: event.capturedAt,
      },
    });
  }
  return tx.scanEvent.findMany({ where: { clientId: { in: keys } }, include: { session: false }, orderBy: { id: "asc" } });
}

export type Tally = {
  items: { itemId: number; qty: number; serials: string[] }[];
  unknown: { code: string | null; name: string | null; qty: number; photo: string | null }[];
};

/** Net the events: corrections are negative events, never deletes. */
export function tally(events: { itemId: number | null; qty: number; serial: string | null; code: string | null; unknownName: string | null; photo: string | null }[]): Tally {
  const items = new Map<number, { qty: number; serials: string[] }>();
  const unknown = new Map<string, { code: string | null; name: string | null; qty: number; photo: string | null }>();
  for (const e of events) {
    if (e.itemId == null) {
      const key = e.code ?? `name:${e.unknownName}`;
      const entry = unknown.get(key) ?? { code: e.code, name: e.unknownName, qty: 0, photo: e.photo };
      entry.qty += e.qty;
      entry.name ??= e.unknownName;
      entry.photo ??= e.photo;
      unknown.set(key, entry);
      continue;
    }
    const entry = items.get(e.itemId) ?? { qty: 0, serials: [] };
    entry.qty += e.qty;
    if (e.serial) {
      if (e.qty > 0) entry.serials.push(e.serial);
      else entry.serials = entry.serials.filter((s) => s !== e.serial);
    }
    items.set(e.itemId, entry);
  }
  return {
    items: [...items.entries()].map(([itemId, v]) => ({ itemId, ...v })).filter((i) => i.qty !== 0),
    unknown: [...unknown.values()].filter((u) => u.qty > 0),
  };
}

/**
 * The clerk is done. The device says how many events it sent; if the server
 * has fewer, some are still in the phone's outbox and it must flush first.
 * Claimed OPEN → SUBMITTED atomically, so a double tap receives once.
 */
export async function submitSession(ctx: StockCtx, sessionId: number, expectedEventCount: number) {
  const { tx } = ctx;
  const count = await tx.scanEvent.count({ where: { sessionId } });
  if (count < expectedEventCount) {
    throw new DomainError(`The server has ${count} of ${expectedEventCount} scans. Some are still on the phone; they will send when it reconnects.`, 409);
  }
  const claimed = await tx.scanSession.updateMany({ where: { id: sessionId, status: "OPEN" }, data: { status: "SUBMITTED", submittedAt: new Date() } });
  if (claimed.count === 0) throw new DomainError("This delivery was already finished", 409);
  const session = await tx.scanSession.findUniqueOrThrow({ where: { id: sessionId }, include: { events: true } });
  const counted = tally(session.events);
  for (const item of counted.items) {
    if (item.qty < 0) throw new DomainError(`Item ${item.itemId} nets to ${item.qty}; fix the count before finishing`, 400);
  }
  if (counted.items.length === 0 && counted.unknown.length === 0) throw new DomainError("Nothing was scanned in this delivery", 400);
  const slip = (session.slipRead as SlipRead | null) ?? null;
  const arrivals: Arrival[] = counted.items.map((i) => ({
    ...i,
    slipPriceCents: slip?.lines?.find((l) => l.itemId === i.itemId)?.unitPriceCents ?? null,
  }));
  const result =
    arrivals.length > 0
      ? await receive(ctx, { warehouseId: session.warehouseId, vendorId: session.vendorId, poId: session.poId, arrivals, scanSessionId: session.id })
      : { poIds: [], receiptIds: [], draftBillIds: [], landedUnits: 0, heldUnits: 0 };
  const summary = { ...result, unknown: counted.unknown.map(({ photo: _photo, ...u }) => u) };
  await tx.scanSession.update({ where: { id: sessionId }, data: { result: summary as unknown as Prisma.InputJsonValue } });
  return summary;
}

/**
 * Map an unknown code from a finished delivery to an item: the barcode is
 * learned for good, and the units are received onto the delivery's order (or
 * a new one) exactly as if they had scanned cleanly.
 */
export async function resolveUnknown(ctx: StockCtx, sessionId: number, input: { code: string | null; name: string | null; itemId: number; serials: string[]; learn: boolean }) {
  const { tx } = ctx;
  const session = await tx.scanSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (session.status !== "SUBMITTED") throw new DomainError("Finish the delivery before resolving its unknown items", 409);
  const summary = session.result as unknown as { poIds: number[]; unknown: { code: string | null; name: string | null; qty: number }[] };
  const index = summary.unknown.findIndex((u) => u.code === input.code && (input.code != null || u.name === input.name));
  if (index === -1) throw new DomainError("That unknown item was already resolved", 409);
  const unknown = summary.unknown[index]!;
  if (input.learn && input.code) await addBarcode(tx, input.itemId, input.code);
  const received = await receive(ctx, {
    warehouseId: session.warehouseId,
    vendorId: session.vendorId,
    poId: summary.poIds[0] ?? session.poId,
    arrivals: [{ itemId: input.itemId, qty: unknown.qty, serials: input.serials }],
    scanSessionId: session.id,
  });
  summary.unknown.splice(index, 1);
  await tx.scanSession.update({ where: { id: sessionId }, data: { result: summary as unknown as Prisma.InputJsonValue } });
  return received;
}
