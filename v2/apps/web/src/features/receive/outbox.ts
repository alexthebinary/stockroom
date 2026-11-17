import Dexie, { type Table } from "dexie";
import { api, assertCompany, companyId } from "../../lib/api";
import type { ScanEvent } from "../../lib/types";

/**
 * Every scan is written to the phone first and sent when there is signal.
 * Each carries its own UUID, so sending twice is harmless: the server keeps
 * one. A delivery can only be finished once nothing is left to send.
 */
export type QueuedEvent = {
  clientId: string;
  companyId: string;
  sessionId: number;
  code: string | null;
  itemId: number | null;
  qty: number;
  serial: string | null;
  unknownName: string | null;
  photo: string | null;
  source: "BARCODE" | "AI" | "MANUAL";
  capturedAt: string;
  sent: 0 | 1;
};

class OutboxDb extends Dexie {
  events!: Table<QueuedEvent, string>;
  constructor() {
    super("profitindex-outbox");
    this.version(1).stores({ events: "clientId, sessionId, sent" });
    // Legacy rows have no owner recorded. Attribute them once to the company
    // selected at upgrade; from here on every read and write has an owner.
    this.version(2).stores({ events: "clientId, [companyId+sessionId], [companyId+sessionId+sent]" })
      .upgrade((tx) => tx.table("events").toCollection().modify({ companyId }));
  }
}

export const outbox = new OutboxDb();

export async function enqueue(event: Omit<QueuedEvent, "sent" | "clientId" | "capturedAt" | "companyId">) {
  assertCompany();
  const queued: QueuedEvent = { ...event, companyId, clientId: crypto.randomUUID(), capturedAt: new Date().toISOString(), sent: 0 };
  await outbox.events.put(queued);
  return queued;
}

/**
 * One camera read is one package. The queued qty is already units
 * (packages × the phone's pack quantity) so the list is right while offline.
 * The server applies pack quantity itself, so the wire qty stays one package.
 * A manual +/- is already units and is sent as stored.
 */
export function wireEvent(event: QueuedEvent) {
  const { sent: _sent, sessionId: _session, companyId: _company, ...body } = event;
  if (body.source === "BARCODE" && body.code) return { ...body, qty: body.qty < 0 ? -1 : 1 };
  return body;
}

export type ReceiptLine = {
  key: string;
  itemId: number | null;
  code: string | null;
  name: string | null;
  qty: number;
  serials: string[];
};

/** Net queued scans into the lines the clerk checks. Server qty wins once a row is sent. */
export function receiptLines(events: Pick<QueuedEvent, "itemId" | "code" | "unknownName" | "qty" | "serial">[]): ReceiptLine[] {
  const map = new Map<string, ReceiptLine>();
  for (const event of events) {
    const key = event.itemId ? `i${event.itemId}` : `c${event.code ?? event.unknownName}`;
    const line = map.get(key) ?? { key, itemId: event.itemId, code: event.code, name: event.unknownName, qty: 0, serials: [] };
    line.qty += event.qty;
    line.name ??= event.unknownName;
    if (event.serial) line.serials = event.qty > 0 ? [...line.serials, event.serial] : line.serials.filter((serial) => serial !== event.serial);
    map.set(key, line);
  }
  return [...map.values()].filter((line) => line.qty !== 0);
}

const flushing = new Map<number, Promise<number>>();

/** Send what hasn't gone yet. Returns how many are still waiting. */
export function flush(sessionId: number): Promise<number> {
  const existing = flushing.get(sessionId);
  if (existing) return existing;
  const sending = (async () => {
    try {
      const pending = await outbox.events.where({ companyId, sessionId, sent: 0 }).toArray();
      for (let i = 0; i < pending.length; i += 100) {
        const batch = pending.slice(i, i + 100);
        const saved = await api<ScanEvent[]>("POST", `/scan-sessions/${sessionId}/events`, {
          events: batch.map((event) => wireEvent(event)),
        }, batch[0]!.companyId);
        // The server's match is the truth (it also knows this vendor's item numbers).
        await outbox.transaction("rw", outbox.events, async () => {
          for (const e of batch) {
            const server = saved.find((s) => s.clientId === e.clientId);
            await outbox.events.update(e.clientId, { sent: 1, itemId: server?.itemId ?? e.itemId, qty: server?.qty ?? e.qty, serial: server?.serial ?? e.serial });
          }
        });
      }
    } catch {
      // Offline or the server is down: everything stays queued for the next try.
    }
    return outbox.events.where({ companyId, sessionId, sent: 0 }).count();
  })().finally(() => { flushing.delete(sessionId); });
  flushing.set(sessionId, sending);
  return sending;
}

export const eventsFor = (sessionId: number) => outbox.events.where({ companyId, sessionId }).toArray();
export const forget = (sessionId: number) => outbox.events.where({ companyId, sessionId }).delete();

/** Resume only deliveries whose company is known. Never guess for old pointers. */
const STATE_KEY = "pi.receive";
type Resume = { companyId: string; sessionId: number; step: number };
export function remember(state: Omit<Resume, "companyId"> | null) {
  assertCompany();
  try {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify({ ...state, companyId }));
    else localStorage.removeItem(STATE_KEY);
  } catch {
    // Storage blocked: the delivery still lives on the server.
  }
}
export function recalled(): Resume | null {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    return state?.companyId === companyId && Number.isInteger(state.sessionId) && Number.isInteger(state.step) ? state : null;
  } catch {
    return null;
  }
}
