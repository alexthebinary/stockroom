import { randomUUID } from "node:crypto";
import type { Client } from "./helpers";
import { ok } from "./helpers";

type Scan = { code?: string; itemId?: number; qty?: number; serial?: string; unknownName?: string; clientId?: string };

/** Drive the clerk's "Receive delivery" over HTTP, exactly as the phone does. */
export async function deliver(clerk: Client, start: { warehouseId: number; vendorId?: number | null; poId?: number | null }, scans: Scan[]) {
  const session = ok(await clerk.post("/api/scan-sessions", { clientId: randomUUID(), ...start })).body;
  const events = scans.map((s) => ({
    clientId: s.clientId ?? randomUUID(),
    code: s.code,
    itemId: s.itemId,
    qty: s.qty ?? 1,
    serial: s.serial,
    unknownName: s.unknownName,
    source: s.code ? "BARCODE" : "MANUAL",
    capturedAt: new Date().toISOString(),
  }));
  if (events.length) ok(await clerk.post(`/api/scan-sessions/${session.id}/events`, { events }));
  const submitted = await clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: events.length });
  return { session, events, submitted };
}
