/**
 * Month-end close, exercised over HTTP.
 *
 * The close is the thing the product sells, so every claim it makes has to be
 * provable from the outside: a blocking check really blocks, fixing the cause
 * really unblocks, and a closed month really is locked by the same guard the
 * ledger already enforces. Each check that matters is driven to FAIL first —
 * a rulebook whose checks have only ever passed has not been tested.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express;
let token: string;
let warehouseId: number;

const PAST = "2026-01";
const PAST_DAY = new Date("2026-01-15T12:00:00Z");

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Close WH", code: "CLOSEWH" } })).id;
});

const failing = (body: { checks: { id: string; passed: boolean }[] }) =>
  body.checks.filter((c) => !c.passed).map((c) => c.id);

describe("month-end close", () => {
  it("refuses a period that is not YYYY-MM", async () => {
    const res = await as(app, token).get("/api/close/2026-13");
    expect(res.status).toBe(400);
  });

  it("reports a finished month with clean books as ready to close", async () => {
    const res = await as(app, token).get(`/api/close/${PAST}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    expect(res.body.blockingFailed).toBe(0);
    expect(res.body.canClose).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(10);
    expect(res.body.periodEnd).toBe("2026-01-31T23:59:59.999Z");
  });

  it("refuses to close the month that is still running", async () => {
    const now = new Date();
    const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const report = await as(app, token).get(`/api/close/${current}`);
    expect(report.body.status).toBe("in_progress");
    expect(report.body.canClose).toBe(false);
    const res = await as(app, token).post(`/api/close/${current}`);
    expect(res.status).toBe(409);
  });

  it("an unbalanced entry in the month blocks the close", async () => {
    const cash = await prisma.account.findFirstOrThrow({ where: { accountType: "ASSET" } });
    const entry = await prisma.journalEntry.create({
      data: {
        entryNumber: "JE-CLOSE-BAD",
        transactionType: "MANUAL",
        entryDate: PAST_DAY,
        status: "POSTED",
        hasBeenPosted: true,
        lines: { create: [{ accountId: cash.id, debitCents: 500, creditCents: 0 }] },
      },
    });

    const report = await as(app, token).get(`/api/close/${PAST}`);
    expect(failing(report.body)).toContain("ledger-sound");
    expect(report.body.canClose).toBe(false);
    const res = await as(app, token).post(`/api/close/${PAST}`);
    expect(res.status).toBe(409);

    await prisma.journalEntry.delete({ where: { id: entry.id } });
  });

  it("an open stock count blocks; cancelling it unblocks; closing locks the books", async () => {
    const api = as(app, token);
    const product = await prisma.product.create({
      data: { sku: "CLOSE-1", name: "Close product", brand: "XAG", defaultCostCents: 100 },
    });
    await prisma.inventoryBalance.create({ data: { productId: product.id, warehouseId } });

    const opened = await api.post("/api/stock-counts").send({ warehouseId, productIds: [product.id] });
    expect(opened.status).toBeLessThan(300);
    // The count was started inside the month being closed.
    await prisma.stockCount.update({ where: { id: opened.body.id }, data: { countedAt: PAST_DAY } });

    const blocked = await api.post(`/api/close/${PAST}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error ?? blocked.body.message).toMatch(/stock count/i);

    const cancel = await api.post(`/api/stock-counts/${opened.body.id}/cancel`);
    expect(cancel.status).toBeLessThan(300);

    const closed = await api.post(`/api/close/${PAST}`);
    expect(closed.status).toBe(200);
    expect(closed.body.record.period).toBe(PAST);
    expect(closed.body.report.status).toBe("closed");

    // The lock is the ledger's own control, so read it back from the ledger.
    const settings = await api.get("/api/ledger-settings");
    expect(settings.body.lockDate.slice(0, 10)).toBe("2026-01-31");

    const again = await api.post(`/api/close/${PAST}`);
    expect(again.status).toBe(409);

    const history = await api.get("/api/close-history");
    expect(history.body.records.map((r: { period: string }) => r.period)).toContain(PAST);
  });

  it("a stock-value gap is found, not assumed away", async () => {
    // A cost layer with no journal entry behind it: the shelves say the
    // company owns more than the balance sheet does.
    const product = await prisma.product.create({
      data: { sku: "CLOSE-2", name: "Unbooked", brand: "XAG", defaultCostCents: 100 },
    });
    await prisma.inventoryLot.create({
      data: {
        productId: product.id, warehouseId, unitCostCents: 250, originalQty: 4, remainingQty: 4,
        sourceType: "TEST",
      },
    });
    const report = await as(app, token).get("/api/close/2026-02");
    const ids = failing(report.body);
    expect(ids).toContain("stock-value-reconciled");
    // No balance row claims those 4 units either.
    const valuation = report.body.checks.find((c: { id: string }) => c.id === "stock-value-reconciled");
    expect(valuation.findings[0].amountCents).toBe(1000);
  });
});
