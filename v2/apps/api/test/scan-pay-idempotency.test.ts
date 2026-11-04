import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { inTx } from "../src/db";
import { submitSession } from "../src/purchasing/scan";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

const WIDGET = "012345678905";
const event = () => ({ clientId: randomUUID(), code: WIDGET, qty: 1, source: "BARCODE", capturedAt: new Date().toISOString() });

async function waitForBlockedScan(completed?: Promise<unknown>) {
  let done = false;
  void completed?.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200; i++) {
    if (done) return;
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
      await waitForBlockedScan(append);
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
    const next = ok(await c.clerk.post("/api/scan-sessions", { clientId: randomUUID(), warehouseId: c.ids.warehouse, vendorId: c.ids.supplier })).body;
    ok(await c.clerk.post(`/api/scan-sessions/${next.id}/events`, { events: [
      { ...event(), itemId: c.ids.widget },
      { ...event(), itemId: c.ids.widget, source: "MANUAL", qty: -1 },
    ] }));
    expect(ok(await c.clerk.post(`/api/scan-sessions/${next.id}/submit`, { expectedEventCount: 2 })).body.heldUnits).toBe(11);
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

async function postedBill(c: Awaited<ReturnType<typeof sampleCompany>>) {
  const po = ok(await c.admin.post("/api/purchase-orders", { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: c.ids.widget, qtyOrdered: 2, unitCostCents: 50000 }] })).body;
  const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body;
  const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: randomUUID() })).body;
  ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));
  return ok(await c.accountant.get(`/api/bills/${draft.id}`)).body;
}

describe("#15 payment action UUIDs", () => {
  it.each(["payments", "refunds"])("concurrent duplicate partial %s record one payment and journal", async (route) => {
    const c = await sampleCompany();
    const bill = await postedBill(c);
    if (route === "refunds") {
      ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 100000 }));
      ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "PRICE_ALLOWANCE", lines: [{ billLineId: bill.lines[0].id, amountCents: 100000 }] }));
    }
    const before = await testDb().payment.count();
    const body = { actionId: randomUUID(), amountCents: 10000, method: "ACH" };
    const results = await Promise.all([
      c.accountant.post(`/api/bills/${bill.id}/${route}`, body),
      c.accountant.post(`/api/bills/${bill.id}/${route}`, body),
    ]);
    results.forEach((r) => ok(r));
    expect(results[0]!.body.id).toBe(results[1]!.body.id);
    expect(await testDb().payment.count()).toBe(before + 1);
    expect(await testDb().journalEntry.count({ where: { sourceType: "PAYMENT", sourceId: results[0]!.body.id } })).toBe(1);
    expect(ok(await c.accountant.post(`/api/bills/${bill.id}/${route}`, body)).body.id).toBe(results[0]!.body.id);
    expect((await c.accountant.post(`/api/bills/${bill.id}/${route}`, { ...body, amountCents: 9000 })).status).toBe(409);
    expect(ok(await c.accountant.post(`/api/bills/${bill.id}/${route}`, { ...body, actionId: randomUUID() })).body.id).not.toBe(results[0]!.body.id);
    await expectBooksSound();
  });

  it("does not reuse an action UUID across bills", async () => {
    const c = await sampleCompany();
    const a = await postedBill(c);
    const b = await postedBill(c);
    const body = { actionId: randomUUID(), amountCents: 10000 };
    const results = await Promise.all([c.accountant.post(`/api/bills/${a.id}/payments`, body), c.accountant.post(`/api/bills/${b.id}/payments`, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await testDb().payment.count()).toBe(1);
    await expectBooksSound();
  });
});

describe("#15 additive payment migration", () => {
  it("preserves legacy payments and allows their NULL action keys", async () => {
    const c = await sampleCompany();
    const bill = await postedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 10000 }));
    ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 10000 }));
    const migration = readFileSync(new URL("../prisma/migrations/20261104150000_payment_action_id/migration.sql", import.meta.url), "utf8");
    await inTx(testDb(), async (tx) => {
      // A temporary copy of populated legacy data; public tables stay untouched.
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "Payment" ON COMMIT DROP AS SELECT * FROM public."Payment"');
      await tx.$executeRawUnsafe('ALTER TABLE pg_temp."Payment" DROP COLUMN "actionId"');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO pg_temp, public');
      for (const statement of migration.split(";").filter((s) => s.trim())) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<{ actionId: string | null; amountCents: number }[]>`SELECT "actionId", "amountCents" FROM "Payment"`;
      expect(rows).toEqual([{ actionId: null, amountCents: 10000 }, { actionId: null, amountCents: 10000 }]);
    });
    expect(await testDb().payment.count()).toBe(2);
    await expectBooksSound();
  });
});
