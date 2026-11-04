import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkBooks } from "../src/books";
import { inTx } from "../src/db";
import { postEntry } from "../src/ledger";
import { ok, sampleCompany, testDb } from "./helpers";

describe("ops review regressions", () => {
  it("#5 reserves inventory accounts for inventory roles", async () => {
    const c = await sampleCompany();
    const inventory = await testDb().account.findUniqueOrThrow({ where: { code: "1200" } });
    for (const role of ["bank", "payable", "cogs"]) {
      expect((await c.admin.put(`/api/posting-rules/${role}`, { accountId: inventory.id })).status).toBe(409);
    }
  });

  it("#5 catches legacy non-inventory postings to the actual inventory account", async () => {
    const c = await sampleCompany();
    const db = testDb();
    const inventory = await db.account.findUniqueOrThrow({ where: { code: "1200" } });
    await db.postingRule.update({ where: { role: "bank" }, data: { accountId: inventory.id } });
    await inTx(db, (tx) => postEntry(tx, {
      event: "BILL_PAYMENT", date: new Date(), sourceType: "TEST", sourceId: 1, actor: "test",
      lines: [{ role: "payable", amountCents: 100, vendorId: c.ids.supplier }, { role: "bank", amountCents: 100 }],
    }));
    // Clear AP's independent discrepancy so only the missed inventory issue remains.
    await db.vendorBill.create({ data: { number: "CREDIT-BALANCE", vendorId: c.ids.supplier, status: "POSTED", billDate: new Date(), dueDate: new Date(), totalCents: 0, creditedCents: 100 } });
    const report = await checkBooks(db);
    expect(report.sound).toBe(false);
    expect(report.problems.join("\n")).toMatch(/Inventory account 1200/);
  });
});

async function billed(c: Awaited<ReturnType<typeof sampleCompany>>, invoice = "INV-OPS", billDate = "2026-10-01") {
  const po = ok(await c.admin.post("/api/purchase-orders", { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: c.ids.widget, qtyOrdered: 1, unitCostCents: 10000 }] })).body;
  const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body;
  const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: invoice, billDate })).body;
  return ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version })).body;
}

it("#18 reconciles payable-role history after reassignment and partial payment", async () => {
  const c = await sampleCompany();
  const bill = await billed(c);
  const account = ok(await c.admin.post("/api/accounts", { code: "2010", name: "New payables", type: "LIABILITY", normalSide: "CREDIT" })).body;
  ok(await c.admin.put("/api/posting-rules/payable", { accountId: account.id }));
  ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 2500 }));
  const report = await checkBooks(testDb());
  expect(report.problems).toEqual([]);
  expect(report.figures.payableGlCents).toBe(7500);
  expect(report.figures.payableOpenCents).toBe(7500);
  // Role history still detects a real mismatch after reassignment.
  await testDb().vendorBill.update({ where: { id: bill.id }, data: { paidCents: 2501 } });
  expect((await checkBooks(testDb())).sound).toBe(false);
});

// Gate later reads until another connection commits valid stock. The same
// instrumentation wraps the real transaction client; it never mocks a query.
function interleavedDb(first: string, commit: () => Promise<void>) {
  let release!: () => void;
  const committed = new Promise<void>((resolve) => { release = resolve; });
  let fired = false;
  let settings: { isolation: string; readOnly: string } | undefined;
  const wrap = (target: any, transaction = false): any => new Proxy(target, {
    get(object, prop) {
      if (prop === "$transaction") return (work: (tx: any) => Promise<unknown>, options: unknown) => object.$transaction((tx: any) => work(wrap(tx, true)), options);
      const value = Reflect.get(object, prop, object);
      if (typeof prop === "string" && value && typeof value === "object" && !prop.startsWith("$")) {
        return new Proxy(value, { get(delegate, method) {
          const fn = Reflect.get(delegate, method, delegate);
          if (typeof fn !== "function") return fn;
          return async (...args: unknown[]) => {
            const key = `${prop}.${String(method)}`;
            if (first === "costPool.findMany" && key === "journalLine.groupBy") await committed;
            const result = await fn.apply(delegate, args);
            if (key === first && !fired) {
              fired = true;
              try {
                if (transaction) {
                  const [isolation] = await object.$queryRawUnsafe("SHOW transaction_isolation");
                  const [readOnly] = await object.$queryRawUnsafe("SHOW transaction_read_only");
                  settings = { isolation: isolation.transaction_isolation, readOnly: readOnly.transaction_read_only };
                }
                await commit();
              } finally { release(); }
            }
            return result;
          };
        } });
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { db: wrap(testDb()) as ReturnType<typeof testDb>, settings: () => settings };
}

for (const report of ["books", "valuation"] as const) {
  it(`#19 ${report} keeps a read-only repeatable snapshot during a concurrent stock posting`, async () => {
    const c = await sampleCompany();
    const instrumented = interleavedDb(report === "books" ? "journalLine.findMany" : "costPool.findMany", async () => {
      ok(await c.admin.post("/api/setup/opening-stock", { lines: [{ itemId: c.ids.widget, warehouseId: c.ids.warehouse, qty: 1, unitCostCents: 10000 }] }));
    });
    if (report === "books") {
      const result = await checkBooks(instrumented.db);
      expect(result.problems).toEqual([]);
      expect(result.figures.onHandPoolCents).toBe(0);
    } else {
      const { buildApp } = await import("../src/app");
      const app = buildApp({ db: instrumented.db, reader: null });
      try {
        const result = await app.inject({ method: "GET", url: "/api/reports/valuation" });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toMatchObject({ totalValueCents: 0, totalGlCents: 0, rows: [] });
      } finally { await app.close(); }
    }
    expect(instrumented.settings()).toEqual({ isolation: "repeatable read", readOnly: "on" });
    expect((await checkBooks(testDb())).figures.onHandPoolCents).toBe(10000);
  });
}

it("#20 includes bills paid after asOf and excludes bills dated after asOf", async () => {
  const c = await sampleCompany();
  const october = await billed(c, "OCT", "2026-10-01");
  await billed(c, "NOV", "2026-11-01");
  ok(await c.accountant.post(`/api/bills/${october.id}/payments`, { amountCents: 10000, paidAt: "2026-11-02" }));
  const report = ok(await c.accountant.get("/api/reports/ap-aging?asOf=2026-10-31T23:59:59.999Z")).body;
  expect(report.vendors).toHaveLength(1);
  expect(report.vendors[0]).toMatchObject({ totalCents: 10000, bills: [{ id: october.id, openCents: 10000 }] });
});

it("#20 applies dated credits, payments and their reversals only through the cutoff", async () => {
  const c = await sampleCompany();
  const bill = await billed(c);
  const payment = ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 2000, paidAt: "2026-10-10" })).body;
  ok(await c.accountant.post(`/api/payments/${payment.id}/void`));
  ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "PRICE_ALLOWANCE", date: "2026-10-20", lines: [{ billLineId: bill.lines[0].id, amountCents: 3000 }] }));
  ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "PRICE_ALLOWANCE", date: "2026-11-01", lines: [{ billLineId: bill.lines[0].id, amountCents: 1000 }] }));
  const report = ok(await c.accountant.get("/api/reports/ap-aging?asOf=2026-10-31T23:59:59.999Z")).body;
  expect(report.vendors[0].totalCents).toBe(5000);
  const today = ok(await c.accountant.get("/api/reports/ap-aging")).body;
  expect(today.vendors[0].totalCents).toBe(6000);
});

it("#20 retains a subsequently voided bill in earlier aging", async () => {
  const c = await sampleCompany();
  const bill = await billed(c);
  ok(await c.accountant.post(`/api/bills/${bill.id}/void`));
  const report = ok(await c.accountant.get("/api/reports/ap-aging?asOf=2026-10-31T23:59:59.999Z")).body;
  expect(report.vendors[0]?.totalCents).toBe(10000);
  expect(ok(await c.accountant.get("/api/reports/ap-aging")).body.vendors).toEqual([]);
});

it("#24 shares a per-client reader quota across endpoints and ignores untrusted forwarding", async () => {
  const c = await sampleCompany();
  const { buildApp } = await import("../src/app");
  const unavailable = async () => ({ ok: false as const, reason: "unavailable" as const, message: "offline" });
  const app = buildApp({ db: testDb(), reader: { readLabel: unavailable, readPackingSlip: unavailable } });
  const read = (i: number, remoteAddress = "198.51.100.7") => app.inject({ method: "POST", url: i % 2 ? "/api/ai/read-slip" : "/api/ai/read-label", remoteAddress,
    headers: { "x-profile": String(c.profiles.clerk.id), "x-forwarded-for": `203.0.113.${i + 1}` }, payload: { image: "data:image/png;base64,iVBORw0KGgo=" } });
  try {
    for (let i = 0; i < 20; i++) expect((await read(i)).statusCode).toBe(200);
    const blocked = await read(20);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await read(21, "198.51.100.8")).statusCode).toBe(200);
  } finally { await app.close(); }
});

it("#24 caps simultaneous reader calls across clients and releases slots", async () => {
  const c = await sampleCompany();
  const { buildApp } = await import("../src/app");
  let finish!: () => void;
  let started!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const twoStarted = new Promise<void>((resolve) => { started = resolve; });
  const readImage = async () => {
    calls++;
    if (calls === 2) started();
    if (calls <= 2) await gate;
    return { ok: false as const, reason: "unavailable" as const, message: "offline" };
  };
  const app = buildApp({ db: testDb(), reader: { readLabel: readImage, readPackingSlip: readImage } });
  const read = (url: string, ip: string) => app.inject({ method: "POST", url, remoteAddress: ip,
    headers: { "x-profile": String(c.profiles.clerk.id) }, payload: { image: "data:image/png;base64,iVBORw0KGgo=" } }).then((r) => r.statusCode);
  const pending = [read("/api/ai/read-label", "198.51.100.1"), read("/api/ai/read-slip", "198.51.100.2")];
  try {
    await twoStarted;
    expect(await read("/api/ai/read-label", "198.51.100.3")).toBe(429);
    expect(calls).toBe(2);
  } finally { finish(); await Promise.all(pending); }
  try { expect(await read("/api/ai/read-slip", "198.51.100.3")).toBe(200); }
  finally { await app.close(); }
});

it("#25 logs unexpected errors by default in production", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env.LOG_LEVEL;
  const script = `
    import { buildApp } from './src/app.ts';
    import { createDb } from './src/db.ts';
    const db = createDb(process.env.TEST_DATABASE_URL);
    const app = buildApp({ db, reader: null });
    app.get('/ops-error', async () => { throw new Error('ops-production-error'); });
    const response = await app.inject({ method: 'GET', url: '/ops-error' });
    console.log(JSON.stringify({ status: response.statusCode, body: response.json() }));
    await app.close();
    await db.$disconnect();
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: new URL("../", import.meta.url), env, encoding: "utf8", timeout: 15000 });
  expect(child.status, child.stderr).toBe(0);
  const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(records.some((r) => r.status === 500)).toBe(true);
  expect(records.some((r) => r.level === 50 && r.err?.message === "ops-production-error")).toBe(true);
});

it("#25 passes the default log level through deploy compose without changing the tunnel pin", () => {
  const compose = readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8");
  const app = compose.split("\n  app:\n")[1]!.split("\n  # Lets")[0]!;
  expect(app).toContain("LOG_LEVEL: ${LOG_LEVEL:-info}");
  expect(compose).toContain("image: cloudflare/cloudflared:2026.9.3");
});
