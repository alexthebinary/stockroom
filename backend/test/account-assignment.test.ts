/**
 * Account Assignment and chart editing over HTTP (client request 2026-09-28).
 *
 * An admin re-points a role; the next posting uses it; each change is audited.
 * Refused: locked roles (valuation and the close reconcile against them), an
 * account of the wrong type, an inactive account, and anyone but an admin.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { SESSION_HEADER } from "../src/auth";

let app: Express;
let token: string;

beforeAll(async () => {
  ({ app, token } = await boot());
});

type Rule = {
  id: number; transactionType: string; role: string; locked: boolean; allowedTypes: string[];
  account: { id: number; code: string }; lastChange: { actor: string } | null;
};

async function rule(transactionType: string, role: string): Promise<Rule> {
  const res = await as(app, token).get("/api/posting-rules");
  expect(res.status).toBe(200);
  return res.body.data.find((r: Rule) => r.transactionType === transactionType && r.role === role);
}
const accountId = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { code } })).id;

describe("account assignment", () => {
  it("lists every rule with its account, side and lock", async () => {
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    expect(r).toMatchObject({ locked: false, allowedTypes: ["EXPENSE"], account: { code: "6000" }, lastChange: null });
    expect((await rule("GOODS_RECEIPT", "debit")).locked).toBe(true);
  });

  it("re-points a role, audits it, and the next posting uses it", async () => {
    const api = as(app, token);
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    const res = await api.put(`/api/posting-rules/${r.id}`).send({ accountId: await accountId("5200") });
    expect(res.status).toBe(200);
    expect(res.body.account.code).toBe("5200");

    const changes = await api.get(`/api/posting-rules/${r.id}/changes`);
    expect(changes.body.data).toHaveLength(1);
    expect(changes.body.data[0]).toMatchObject({ from: { code: "6000" }, to: { code: "5200" } });
    expect((await rule("ADJUSTMENT_DECREASE", "debit")).lastChange).not.toBeNull();

    // The next write-off posts to 5200.
    const wh = await prisma.warehouse.create({ data: { name: "AA", code: "AAWH" } });
    const p = (await api.post("/api/products").send({ sku: "AA-1", name: "aa" })).body;
    const adj = (type: string) => api.post("/api/stock-adjustments").send({
      productId: p.id, warehouseId: wh.id, adjustmentType: type, quantity: 1, reason: "t", unitCostCents: 300,
    });
    expect((await adj("INCREASE")).status).toBeLessThan(300);
    expect((await adj("DECREASE")).status).toBeLessThan(300);
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { transactionType: "ADJUSTMENT_DECREASE" }, orderBy: { id: "desc" },
      include: { lines: { include: { account: true } } },
    });
    expect(entry.lines.find((l) => l.debitCents > 0)!.account.code).toBe("5200");

    // Same account again: no second audit row.
    await api.put(`/api/posting-rules/${r.id}`).send({ accountId: await accountId("5200") });
    expect((await api.get(`/api/posting-rules/${r.id}/changes`)).body.data).toHaveLength(1);
  });

  it("refuses a locked role", async () => {
    const r = await rule("GOODS_RECEIPT", "debit");
    const res = await as(app, token).put(`/api/posting-rules/${r.id}`).send({ accountId: await accountId("1000") });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("refuses an account of the wrong type", async () => {
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    const res = await as(app, token).put(`/api/posting-rules/${r.id}`).send({ accountId: await accountId("4000") });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/EXPENSE/);
  });

  it("refuses an inactive account", async () => {
    const created = await as(app, token).post("/api/accounts").send({ code: "6200", name: "Old expense", accountType: "EXPENSE" });
    expect(created.status).toBe(201);
    await as(app, token).put(`/api/accounts/${created.body.id}`).send({ isActive: false });
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    const res = await as(app, token).put(`/api/posting-rules/${r.id}`).send({ accountId: created.body.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/i);
  });

  it("refuses to point an unlocked role at an inventory or clearing account", async () => {
    // SALES_PAYMENT debit accepts ASSET accounts, but 1200 is reconciled
    // against the cost pools: a payment posted there is a permanent variance.
    const r = await rule("SALES_PAYMENT", "debit");
    const res = await as(app, token).put(`/api/posting-rules/${r.id}`).send({ accountId: await accountId("1200") });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reserved|locked/i);
  });

  it("refuses anyone but an admin", async () => {
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    const res = await request(app)
      .put(`/api/posting-rules/${r.id}`)
      .set(SESSION_HEADER, token)
      .set("X-Act-As-Role", "FINANCE")
      .send({ accountId: await accountId("6000") });
    expect(res.status).toBe(403);
  });
});

describe("chart of accounts editing", () => {
  it("adds an account and derives its normal side", async () => {
    const res = await as(app, token).post("/api/accounts").send({ code: "6300", name: "Bank fees", accountType: "EXPENSE" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: "6300", normalSide: "DEBIT", isActive: true });
  });

  it("refuses a duplicate or malformed code", async () => {
    const api = as(app, token);
    expect((await api.post("/api/accounts").send({ code: "1000", name: "Dup", accountType: "ASSET" })).status).toBe(409);
    expect((await api.post("/api/accounts").send({ code: "12", name: "Bad", accountType: "ASSET" })).status).toBe(400);
  });

  it("renames an account", async () => {
    const id = await accountId("6300");
    const res = await as(app, token).put(`/api/accounts/${id}`).send({ name: "Bank charges" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Bank charges");
  });

  it("refuses to deactivate an account a rule uses", async () => {
    const res = await as(app, token).put(`/api/accounts/${await accountId("1100")}`).send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/SALES_INVOICE/);
  });

  it("refuses to change the type of an account a rule uses", async () => {
    const api = as(app, token);
    const created = (await api.post("/api/accounts").send({ code: "6400", name: "Shrinkage", accountType: "EXPENSE" })).body;
    const r = await rule("ADJUSTMENT_DECREASE", "debit");
    expect((await api.put(`/api/posting-rules/${r.id}`).send({ accountId: created.id })).status).toBe(200);
    const res = await api.put(`/api/accounts/${created.id}`).send({ accountType: "OFF_BALANCE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ADJUSTMENT_DECREASE/);
  });

  it("refuses to change the type of an account with postings", async () => {
    const res = await as(app, token).put(`/api/accounts/${await accountId("1200")}`).send({ accountType: "EXPENSE" });
    expect(res.status).toBe(409);
  });
});
