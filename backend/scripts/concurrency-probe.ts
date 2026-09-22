/**
 * Concurrency probe: can two partial payments overpay one invoice?
 *
 * NOT a vitest test, and deliberately so. The suite runs on SQLite, which
 * serialises every write through a single connection, so this race cannot
 * physically occur there — a test asserting it would be a check that can
 * never fail. It only exists on Postgres, which is what production runs.
 *
 * Usage:
 *
 *   docker run -d --name pgprobe -e POSTGRES_PASSWORD=race -e POSTGRES_DB=race \
 *     -p 55433:5432 postgres:16-alpine
 *   export DATABASE_URL="postgresql://postgres:race@127.0.0.1:55433/race"
 *   node prisma/to-postgres.mjs
 *   npx prisma db push --schema prisma/postgres/schema.prisma --skip-generate
 *   npx prisma generate --schema prisma/postgres/schema.prisma
 *   npx tsx scripts/concurrency-probe.ts
 *   # afterwards: npx prisma generate --schema prisma/schema.prisma
 *
 * Exits non-zero if the invoice ends up overpaid.
 *
 * Measured 2026-09-22 with a 400ms window forced between the balance read and
 * the payment write: WITHOUT the row lock in src/payments.ts both requests
 * returned 201 and $600 landed on a $500 invoice. WITH it, 201 + 400 and $300.
 * Note that without an artificially widened window the race did not reproduce
 * on this machine — the window is real but narrow, which is exactly why it
 * survived review.
 */
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { createApp } from "../src/app";
import { syncChartOfAccounts } from "../src/accounts";
import { ensureBootstrapAdmin, hashPassword, SESSION_HEADER } from "../src/auth";
import { ensureDocumentCounters } from "../src/numbering";

const prisma = new PrismaClient();

(async () => {
  await syncChartOfAccounts();
  await ensureDocumentCounters();
  await ensureBootstrapAdmin();
  // Own credential: ensureBootstrapAdmin only returns a password the first
  // time it creates the account, so a second run had none and sent an
  // undefined auth header.
  const email = "race-probe@local.test";
  await prisma.user.deleteMany({ where: { email } });
  await prisma.user.create({
    data: { email, name: "Race Probe", role: "ADMIN", passwordHash: hashPassword("race-pass-1234") },
  });
  const app = createApp();
  const login = await request(app).post("/api/auth/login").send({ email, password: "race-pass-1234" });
  if (!login.body.token) throw new Error("probe login failed: " + JSON.stringify(login.body));
  const token = login.body.token as string;
  const api = (m: "get" | "post", u: string) => request(app)[m](u).set(SESSION_HEADER, token);

  const wh = await prisma.warehouse.create({ data: { name: "Race", code: "RACE" + Date.now() } });
  const product = await prisma.product.create({
    data: { sku: "RACE-" + Date.now(), name: "Race widget", brand: "XAG", defaultPriceCents: 50_000 },
  });
  const customer = await prisma.customer.create({ data: { name: "Race Buyer" } });
  await prisma.inventoryBalance.create({
    data: { productId: product.id, warehouseId: wh.id, onHandQty: 100 },
  });
  await prisma.inventoryLot.create({
    data: { productId: product.id, warehouseId: wh.id, unitCostCents: 10_000,
            originalQty: 100, remainingQty: 100, sourceType: "TEST" },
  });

  // One invoice for $500.
  const created = await api("post", "/api/sales-orders")
    .send({ customerId: customer.id, lines: [{ productId: product.id, warehouseId: wh.id, quantity: 1, unitPriceCents: 50_000 }] });
  const orderId = created.body.id;
  await api("post", `/api/sales-orders/${orderId}/pack`);
  await api("post", `/api/sales-orders/${orderId}/invoice`);
  const detail = await api("get", `/api/sales-orders/${orderId}`);
  const invoiceId = detail.body.invoices[0].id;
  const total = detail.body.invoices[0].totalCents;

  // Two $300 payments at once against a $500 balance. At most one may land.
  const [a, b] = await Promise.all([
    api("post", `/api/sales-orders/${orderId}/pay`).send({ amountCents: 30_000 }),
    api("post", `/api/sales-orders/${orderId}/pay`).send({ amountCents: 30_000 }),
  ]);

  const payments = await prisma.payment.findMany({ where: { invoiceId, status: { not: "VOID" } } });
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);

  console.log(`  invoice total      : ${total}`);
  console.log(`  responses          : ${a.status}, ${b.status}`);
  console.log(`  payments recorded  : ${payments.length} totalling ${paid}`);
  console.log(`  OVERPAID?          : ${paid > total ? "YES — money invented" : "no"}`);
  process.exitCode = paid > total ? 1 : 0;
  await prisma.$disconnect();
})();
