import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { inTx, type Tx } from "../src/db";
import { postInventoryBill } from "../src/purchasing/bills";
import { postVendorCredit } from "../src/purchasing/credits";
import { receive } from "../src/purchasing/receive";
import { voidBill } from "../src/purchasing/void";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Pause after a real DB read, keeping its transaction open. The competitor
// either commits (old code) or demonstrably waits on that transaction's lock.
async function race<A, B>(first: (tx: Tx, pause: () => Promise<void>) => Promise<A>, second: () => Promise<B>) {
  const entered = gate();
  const release = gate();
  let pid = 0;
  const a = inTx(testDb(), async (tx) => {
    [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    return first(tx, async () => { entered.resolve(); await release.promise; });
  });
  const aResult = a.then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, a.then(() => { throw new Error("First operation did not reach pause"); })]);
  let finished = false;
  const bResult = second().then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
  try {
    const deadline = Date.now() + 5000;
    while (!finished) {
      const [row] = await testDb().$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
      if (row!.blocked) break;
      if (Date.now() > deadline) throw new Error("Competitor neither completed nor waited on the first transaction");
      await delay(10);
    }
  } finally {
    release.resolve();
  }
  return Promise.all([aResult, bResult]);
}

function pauseRead(tx: Tx, model: "purchaseOrderLine" | "vendorBill", method: "findUniqueOrThrow", pause: () => Promise<void>): Tx {
  let once = true;
  return new Proxy(tx, {
    get(target, key) {
      if (key !== model) return Reflect.get(target, key);
      return new Proxy(target[model], {
        get(delegate, operation) {
          const original = Reflect.get(delegate, operation);
          if (operation !== method) return original;
          return async (...args: unknown[]) => {
            const result = await original.apply(delegate, args);
            if (once) { once = false; await pause(); }
            return result;
          };
        },
      });
    },
  });
}

async function fixture() {
  const c = await sampleCompany();
  const po = ok(await c.admin.post("/api/purchase-orders", {
    vendorId: c.ids.supplier, warehouseId: c.ids.warehouse,
    lines: [{ itemId: c.ids.widget, qtyOrdered: 1, unitCostCents: 50000 }],
  })).body;
  const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body;
  const bill = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "LOCK-1" })).body;
  return { ...c, po, bill };
}
const ctx = (tx: Tx) => ({ tx, actor: "Lock test" });

describe("purchasing locking regressions", () => {
  it("#3 rejects an edit that overlaps posting without changing the posted bill", async () => {
    const c = await fixture();
    const [posted, edited] = await race(async (tx, pause) => {
      const result = await postInventoryBill(ctx(tx), c.bill.id, c.bill.version);
      await pause();
      return result;
    }, () => c.accountant.patch(`/api/bills/${c.bill.id}`, {
      version: c.bill.version, vendorInvoiceNumber: "STALE", lines: [{ id: c.bill.lines[0].id, qty: 1, unitCostCents: 1 }],
    }));
    expect(posted).not.toHaveProperty("error");
    expect(edited).toMatchObject({ value: { status: 409 } });
    expect(await testDb().vendorBill.findUniqueOrThrow({ where: { id: c.bill.id } })).toMatchObject({ status: "POSTED", vendorInvoiceNumber: "LOCK-1", totalCents: 50000 });
    await expectBooksSound();
  });

  it("#6 serializes two bills for the last ordered unit", async () => {
    const c = await fixture();
    const draft = ok(await c.accountant.post("/api/bills", { poId: c.po.id })).body;
    const other = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "LOCK-2" })).body;
    const results = await race((tx, pause) => postInventoryBill(ctx(pauseRead(tx, "purchaseOrderLine", "findUniqueOrThrow", pause)), c.bill.id, c.bill.version),
      () => inTx(testDb(), tx => postInventoryBill(ctx(tx), other.id, other.version)));
    expect(results.filter(r => "value" in r)).toHaveLength(1);
    expect(results.filter(r => "error" in r)).toHaveLength(1);
    expect(await testDb().purchaseOrderLine.findUniqueOrThrow({ where: { id: c.po.lines[0].id } })).toMatchObject({ qtyBilled: 1, inboundCents: 50000 });
    expect(await testDb().vendorBill.count({ where: { status: "POSTED" } })).toBe(1);
    await expectBooksSound();
  });

});
