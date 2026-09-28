import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, parseBody } from "../http";
import { requireUsers } from "../auth";
import { LOCKED_CODES, POSTING_ROLES, assignedRoles, linkedWith, type AccountType } from "../posting";
import type { TransactionType } from "../accounts";

/**
 * Account Assignment and the chart of accounts, as admin-edited data
 * (client request 2026-09-28). Reads are open to any signed-in user; every
 * write is ADMIN-only (`requireUsers`), because it changes where money posts.
 */
export const accountingRouter = Router();

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE", "OFF_BALANCE"] as const;
const DEBIT_NORMAL = new Set<string>(["ASSET", "EXPENSE"]);

/** GET /api/posting-rules — every role of every transaction type, with its account. */
accountingRouter.get(
  "/posting-rules",
  asyncHandler(async (_req, res) => {
    const [types, lastChanges] = await Promise.all([
      assignedRoles(),
      prisma.postingRuleChange.findMany({ orderBy: { id: "desc" }, distinct: ["ruleId"] }),
    ]);
    res.json({
      data: types.flatMap((t) =>
        t.roles.map((r) => {
          const last = lastChanges.find((c) => c.ruleId === r.ruleId);
          return {
            id: r.ruleId,
            transactionType: t.transactionType,
            description: t.description,
            role: r.role,
            label: r.label,
            side: r.side,
            locked: r.locked,
            allowedTypes: r.allowedTypes,
            account: { id: r.account.id, code: r.account.code, name: r.account.name },
            lastChange: last ? { actor: last.actor, changedAt: last.changedAt } : null,
          };
        })
      ),
    });
  })
);

/** GET /api/posting-rules/:id/changes — the audit trail of one rule, newest first. */
accountingRouter.get(
  "/posting-rules/:id/changes",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const [changes, accounts] = await Promise.all([
      prisma.postingRuleChange.findMany({ where: { ruleId: id }, orderBy: { id: "desc" } }),
      prisma.account.findMany({ select: { id: true, code: true, name: true } }),
    ]);
    const ref = (accountId: number) => accounts.find((a) => a.id === accountId) ?? { id: accountId, code: "?", name: "(deleted)" };
    res.json({
      data: changes.map((c) => ({ id: c.id, actor: c.actor, changedAt: c.changedAt, from: ref(c.fromAccountId), to: ref(c.toAccountId) })),
    });
  })
);

/** PUT /api/posting-rules/:id { accountId } — re-point one role. */
accountingRouter.put(
  "/posting-rules/:id",
  requireUsers,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const body = parseBody(z.object({ accountId: z.number().int().positive() }), req.body);
    const actor = actorOf(req);

    const updated = await prisma.$transaction(async (tx) => {
      const rule = await tx.postingRule.findUnique({ where: { id } });
      if (!rule) throw notFound("Posting rule not found");
      const role = POSTING_ROLES[rule.transactionType as TransactionType]?.find((r) => r.role === rule.role);
      if (!role) throw notFound("That posting rule is no longer used");
      if (role.locked) {
        throw conflict(
          `${rule.transactionType} ${role.label.toLowerCase()} is locked: the stock valuation and month-end close reconcile against this account`
        );
      }
      const account = await tx.account.findUnique({ where: { id: body.accountId } });
      if (!account) throw notFound("Account not found");
      if (!account.isActive) throw badRequest(`${account.code} ${account.name} is inactive`);
      // The reverse of a locked role: other transactions must not post INTO
      // the accounts the valuation and close reconcile, or a payment lands in
      // Inventory with no stock behind it and the books never agree again.
      if (LOCKED_CODES.has(account.code)) {
        throw conflict(`${account.code} ${account.name} is reserved for stock postings (valuation and close reconcile it)`);
      }
      if (!role.allowedTypes.includes(account.accountType as AccountType)) {
        throw badRequest(
          `${rule.transactionType} ${role.label.toLowerCase()} needs an account of type ${role.allowedTypes.join(" or ")}; ` +
            `${account.code} is ${account.accountType}`
        );
      }
      // Linked lines move together (see LINKED_ROLES), each audited, and each
      // must accept the account on its own terms.
      for (const link of linkedWith(rule.transactionType, rule.role)) {
        const member = await tx.postingRule.findUnique({
          where: { transactionType_role: { transactionType: link.transactionType, role: link.role } },
        });
        if (!member || member.accountId === account.id) continue;
        const memberRole = POSTING_ROLES[link.transactionType as TransactionType]?.find((r) => r.role === link.role);
        if (memberRole && !memberRole.allowedTypes.includes(account.accountType as AccountType)) {
          throw badRequest(
            `${link.transactionType} ${memberRole.label.toLowerCase()} moves with this line and needs ` +
              `${memberRole.allowedTypes.join(" or ")}; ${account.code} is ${account.accountType}`
          );
        }
        await tx.postingRule.update({ where: { id: member.id }, data: { accountId: account.id } });
        await tx.postingRuleChange.create({
          data: { ruleId: member.id, fromAccountId: member.accountId, toAccountId: account.id, actor },
        });
      }
      return tx.postingRule.findUniqueOrThrow({ where: { id }, include: { account: true } });
    });

    res.json({ id: updated.id, transactionType: updated.transactionType, role: updated.role, account: updated.account });
  })
);

/** POST /api/accounts { code, name, accountType, normalSide? } */
accountingRouter.post(
  "/accounts",
  requireUsers,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        code: z.string().regex(/^\d{4}$/, "An account code is four digits"),
        name: z.string().trim().min(1),
        accountType: z.enum(ACCOUNT_TYPES),
        /// Only needed for OFF_BALANCE, where either side is legitimate.
        normalSide: z.enum(["DEBIT", "CREDIT"]).optional(),
      }),
      req.body
    );
    if (await prisma.account.findUnique({ where: { code: body.code } })) {
      throw conflict(`Account ${body.code} already exists`);
    }
    if (body.accountType === "OFF_BALANCE" && !body.normalSide) {
      throw badRequest("An off-balance account needs a normal side (DEBIT or CREDIT)");
    }
    const normalSide = body.normalSide ?? (DEBIT_NORMAL.has(body.accountType) ? "DEBIT" : "CREDIT");
    const account = await prisma.account.create({
      data: { code: body.code, name: body.name, accountType: body.accountType, normalSide },
    });
    res.status(201).json(account);
  })
);

/** PUT /api/accounts/:id { name?, accountType?, isActive? } */
accountingRouter.put(
  "/accounts/:id",
  requireUsers,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).optional(),
        accountType: z.enum(ACCOUNT_TYPES).optional(),
        isActive: z.boolean().optional(),
      }),
      req.body
    );
    const account = await prisma.$transaction(async (tx) => {
      const current = await tx.account.findUnique({ where: { id } });
      if (!current) throw notFound("Account not found");
      const data: { name?: string; accountType?: string; normalSide?: string; isActive?: boolean } = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.accountType !== undefined && body.accountType !== current.accountType) {
        const lines = await tx.journalLine.count({ where: { accountId: id } });
        if (lines > 0) throw conflict(`${current.code} has ${lines} posted line(s); its type cannot change`);
        // A rule chose this account for its type; changing it underneath would
        // post e.g. an expense into an off-balance account.
        const using = await tx.postingRule.findMany({ where: { accountId: id } });
        if (using.length) {
          throw conflict(
            `${current.code} is assigned to ${using.map((r) => `${r.transactionType} ${r.role}`).join(", ")} — reassign before changing its type`
          );
        }
        data.accountType = body.accountType;
        if (body.accountType !== "OFF_BALANCE") {
          data.normalSide = DEBIT_NORMAL.has(body.accountType) ? "DEBIT" : "CREDIT";
        }
      }
      if (body.isActive === false && current.isActive) {
        const using = await tx.postingRule.findMany({ where: { accountId: id } });
        if (using.length) {
          throw conflict(
            `${current.code} is assigned to ${using.map((r) => `${r.transactionType} ${r.role}`).join(", ")} — reassign first`
          );
        }
      }
      if (body.isActive !== undefined) data.isActive = body.isActive;
      return tx.account.update({ where: { id }, data });
    });
    res.json(account);
  })
);
