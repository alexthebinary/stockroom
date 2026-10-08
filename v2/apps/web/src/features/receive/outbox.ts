import Dexie, { type Table } from "dexie";
import { post } from "../../lib/api";
import type { ScanEvent } from "../../lib/types";

/**
 * Every scan is written to the phone first and sent when there is signal.
 * Each carries its own UUID, so sending twice is harmless: the server keeps
 * one. A delivery can only be finished once nothing is left to send.
 */
export type QueuedEvent = {
  clientId: string;
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
  }
}

export const outbox = new OutboxDb();

export async function enqueue(event: Omit<QueuedEvent, "sent" | "clientId" | "capturedAt">) {
  const queued: QueuedEvent = { ...event, clientId: crypto.randomUUID(), capturedAt: new Date().toISOString(), sent: 0 };
  await outbox.events.put(queued);
  return queued;
}

let flushing: Promise<number> | null = null;

/** Send what hasn't gone yet. Returns how many are still waiting. */
export function flush(sessionId: number): Promise<number> {
  flushing ??= (async () => {
    try {
      const pending = await outbox.events.where({ sessionId, sent: 0 }).toArray();
      for (let i = 0; i < pending.length; i += 100) {
        const batch = pending.slice(i, i + 100);
        const saved = await post<ScanEvent[]>(`/scan-sessions/${sessionId}/events`, {
          events: batch.map(({ sent: _sent, sessionId: _s, ...e }) => e),
        });
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
    return outbox.events.where({ sessionId, sent: 0 }).count();
  })().finally(() => (flushing = null));
  return flushing;
}

export const eventsFor = (sessionId: number) => outbox.events.where({ sessionId }).toArray();
export const forget = (sessionId: number) => outbox.events.where({ sessionId }).delete();
