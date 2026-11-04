import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { inTx } from "../src/db";
import { submitSession } from "../src/purchasing/scan";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

const WIDGET = "012345678905";
const event = () => ({ clientId: randomUUID(), code: WIDGET, qty: 1, source: "BARCODE", capturedAt: new Date().toISOString() });

async function waitForBlockedScan() {
  for (let i = 0; i < 200; i++) {
    const rows = await testDb().$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE '%Scan%') AS blocked`;
    if (rows[0]?.blocked) return;
    await delay(10);
  }
  throw new Error("Expected a scan request to wait for the transaction's session lock");
}

async function pausedSubmit(sessionId: number, work: () => Promise<void>) {
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const submit = inTx(testDb(), async (tx) => {
    const result = await submitSession({ tx, actor: "Test" }, sessionId, 1);
    ready();
    await gate;
    return result;
  });
  await started;
  try { await work(); } finally { release(); await submit; }
}

describe("scan/pay review regression batch", () => {
  it("#13 concurrent resolutions without learning receive an unknown only once", async () => {
    const c = await sampleCompany();
    const { session, submitted } = await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: "unknown-batch", qty: 3 }]);
    ok(submitted);
    const resolve = () => c.clerk.post(`/api/scan-sessions/${session.id}/resolve`, { code: "unknown-batch", itemId: c.ids.widget, learn: false });
    const results = await Promise.all([resolve(), resolve()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await testDb().stockBalance.findFirstOrThrow({ where: { itemId: c.ids.widget } })).held).toBe(3);
    expect(await testDb().warehouseReceipt.count()).toBe(1);
    await expectBooksSound();
  });

  it("#14 an append waiting behind submit is rejected instead of silently lost", async () => {
    const c = await sampleCompany();
    const session = ok(await c.clerk.post("/api/scan-sessions", { clientId: randomUUID(), warehouseId: c.ids.warehouse, vendorId: c.ids.supplier })).body;
    ok(await c.clerk.post(`/api/scan-sessions/${session.id}/events`, { events: [event()] }));
    let append!: ReturnType<typeof c.clerk.post>;
    await pausedSubmit(session.id, async () => {
      append = c.clerk.post(`/api/scan-sessions/${session.id}/events`, { events: [event()] });
      await Promise.race([append, waitForBlockedScan()]);
    });
    const result = await append;
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.error).toMatch(/finished|submitted/i);
    expect(await testDb().scanEvent.count({ where: { sessionId: session.id } })).toBe(1);
    await expectBooksSound();
  });

  it("#14 abandon waits behind submit and cannot abandon a finished delivery", async () => {
    const c = await sampleCompany();
    const session = ok(await c.clerk.post("/api/scan-sessions", { clientId: randomUUID(), warehouseId: c.ids.warehouse, vendorId: c.ids.supplier })).body;
    ok(await c.clerk.post(`/api/scan-sessions/${session.id}/events`, { events: [event()] }));
    let abandon!: ReturnType<typeof c.clerk.post>;
    await pausedSubmit(session.id, async () => {
      abandon = c.clerk.post(`/api/scan-sessions/${session.id}/abandon`);
      await waitForBlockedScan();
    });
    expect((await abandon).status).toBe(409);
    expect((await testDb().scanSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("SUBMITTED");
  });

  it("#16 a recognized case barcode counts packQty even with the client's itemId", async () => {
    const c = await sampleCompany();
    await testDb().itemBarcode.updateMany({ where: { itemId: c.ids.widget }, data: { packQty: 12 } });
    const { submitted } = await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: WIDGET, itemId: c.ids.widget }]);
    expect(ok(submitted).body.heldUnits).toBe(12);
    await expectBooksSound();
  });

  it("#21 retrying submit with the same count returns the saved result", async () => {
    const c = await sampleCompany();
    const { session, submitted } = await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: WIDGET }]);
    ok(submitted);
    const retry = await c.clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: 1 });
    expect(ok(retry).body).toEqual(submitted.body);
    expect((await c.clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: 0 })).status).toBe(409);
    expect(await testDb().warehouseReceipt.count()).toBe(1);
    await expectBooksSound();
  });
});
