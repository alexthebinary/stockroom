import { ROLES } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { checkBooks } from "../books";
import { inTx } from "../db";
import { actorOf, idParam, parse } from "../http";
import { repointRole } from "../ledger";

export function registerAccounting(app: FastifyInstance, { db }: Deps) {
  /** The chart with each account's balance (normal side positive). */
  app.get("/api/accounts", async () => {
    const [accounts, sums] = await Promise.all([
      db.account.findMany({ orderBy: { code: "asc" } }),
      db.journalLine.groupBy({ by: ["accountId", "side"], _sum: { amountCents: true } }),
    ]);
    return accounts.map((a) => {
      const debit = sums.find((s) => s.accountId === a.id && s.side === "DEBIT")?._sum.amountCents ?? 0;
      const credit = sums.find((s) => s.accountId === a.id && s.side === "CREDIT")?._sum.amountCents ?? 0;
      return { ...a, balanceCents: a.normalSide === "DEBIT" ? debit - credit : credit - debit };
    });
  });

  app.post("/api/accounts", async (request) => {
    const body = parse(
      z.object({
        code: z.string().trim().regex(/^\d{4}$/, "Use a four-digit code"),
        name: z.string().trim().min(1),
        type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
        normalSide: z.enum(["DEBIT", "CREDIT"]),
        parentId: z.number().int().positive().nullish(),
        purpose: z.string().trim().optional(),
      }),
      request.body,
    );
    return db.account.create({ data: body });
  });

  app.put("/api/accounts/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ name: z.string().trim().min(1).optional(), purpose: z.string().trim().optional(), isActive: z.boolean().optional() }), request.body);
    return db.account.update({ where: { id }, data: body });
  });

  app.get("/api/posting-rules", async () => {
    const rules = await db.postingRule.findMany({ include: { account: true, changes: { orderBy: { at: "desc" }, take: 5 } } });
    return rules.map((r) => ({ ...r, ...ROLES[r.role as keyof typeof ROLES] }));
  });

  app.put("/api/posting-rules/:role", async (request) => {
    const { role } = parse(z.object({ role: z.string() }), request.params);
    const { accountId } = parse(z.object({ accountId: z.number().int().positive() }), request.body);
    return inTx(db, (tx) => repointRole(tx, role, accountId, actorOf(request)));
  });

  app.get("/api/books/check", async () => checkBooks(db));

  /** The general journal, newest first; filter by kind of transaction, page with skip. */
  app.get("/api/journal", async (request) => {
    const q = parse(
      z.object({
        sourceType: z.string().optional(),
        sourceId: z.coerce.number().int().optional(),
        event: z.string().optional(),
        take: z.coerce.number().int().min(1).max(500).default(50),
        skip: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
    );
    return db.journalEntry.findMany({
      where: { ...(q.sourceType ? { sourceType: q.sourceType } : {}), ...(q.sourceId != null ? { sourceId: q.sourceId } : {}), ...(q.event ? { event: q.event } : {}) },
      // Debits first, as a journal reads.
      include: { lines: { include: { account: true }, orderBy: [{ side: "desc" }, { id: "asc" }] }, reverses: { select: { number: true } } },
      orderBy: { id: "desc" },
      take: q.take,
      skip: q.skip,
    });
  });
}
