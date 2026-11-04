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
          events: batch.map(({ sent: _sent, sessionId: _s, companyId: _company, ...e }) => e),
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
