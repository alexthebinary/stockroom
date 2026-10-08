import { expect } from "vitest";
import { buildApp } from "../src/app";
import { checkBooks } from "../src/books";
import { createDb, type Db } from "../src/db";
import { syncChart } from "../src/ledger";

let db: Db | undefined;

export function testDb(): Db {
  db ??= createDb(process.env.TEST_DATABASE_URL);
  return db;
}

/** Empty every table (keeping the migrations) and seed the chart, as a fresh install would. */
export async function resetDb(): Promise<Db> {
  const d = testDb();
  const tables = await d.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await d.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await syncChart(d);
  return d;
}

export type Client = ReturnType<typeof client>;

/** An HTTP client against the in-process app, acting as `profileId` when given. */
export function client(profileId?: number) {
  const app = buildApp({ db: testDb(), reader: null });
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      payload: payload as never,
      headers: profileId ? { "x-profile": String(profileId) } : {},
    });
    const body = response.body ? JSON.parse(response.body) : null;
    return { status: response.statusCode, body };
  };
  return {
    app,
    get: (url: string) => call("GET", url),
    post: (url: string, payload?: unknown) => call("POST", url, payload ?? {}),
    put: (url: string, payload?: unknown) => call("PUT", url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call("PATCH", url, payload ?? {}),
    del: (url: string) => call("DELETE", url),
  };
}

/** Assert a response status, showing the server's message when it is not what was expected. */
export function ok<T extends { status: number; body: unknown }>(response: T, status = 200): T {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

export async function expectBooksSound() {
  const report = await checkBooks(testDb());
  expect(report.problems, "books should be sound").toEqual([]);
  return report;
}

/** A fresh company with the sample data and an admin, a clerk and an accountant. */
export async function sampleCompany() {
  await resetDb();
  const anon = client();
  ok(await anon.put("/api/setup/company", { name: "Test Co", homeState: "PA" }));
  const admin = ok(await anon.post("/api/profiles", { name: "Ada Admin", job: "ADMIN" })).body;
  const clerk = ok(await anon.post("/api/profiles", { name: "Cal Clerk", job: "CLERK" })).body;
  const accountant = ok(await anon.post("/api/profiles", { name: "Ann Accountant", job: "ACCOUNTING" })).body;
  ok(await client(admin.id).post("/api/setup/sample-data"));
  const d = testDb();
  const ids = {
    warehouse: (await d.warehouse.findFirstOrThrow()).id,
    supplier: (await d.vendor.findFirstOrThrow({ where: { kind: "SUPPLIER" } })).id,
    carrier: (await d.vendor.findFirstOrThrow({ where: { kind: "CARRIER" } })).id,
    widget: (await d.item.findUniqueOrThrow({ where: { sku: "SAMPLE-WIDGET" } })).id,
    robot: (await d.item.findUniqueOrThrow({ where: { sku: "SAMPLE-ROBOT" } })).id,
    openBox: (await d.item.findUniqueOrThrow({ where: { sku: "SAMPLE-WIDGET-OB" } })).id,
  };
  return { ids, admin: client(admin.id), clerk: client(clerk.id), accountant: client(accountant.id), profiles: { admin, clerk, accountant } };
}
