import { Router } from "express";
import { prisma } from "../db";
import { conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, optionalInt, pagination } from "../http";
import { balanceOf, reverseEntry, unpostEntry } from "../ledger";

export const ledgerRouter = Router();

/** GET /api/journal-entries?transactionType=&status=&from=&to= */
ledgerRouter.get(
  "/journal-entries",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const transactionType = String(req.query.transactionType ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const from = String(req.query.from ?? "").trim();
    const to = String(req.query.to ?? "").trim();

    const where = {
      ...(transactionType ? { transactionType } : {}),
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            entryDate: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        skip,
        take,
        include: { lines: { include: { account: true } } },
        orderBy: [{ entryDate: "desc" }, { id: "desc" }],
      }),
    ]);

    res.json({
      data: rows.map((e) => ({
        ...e,
        totalDebitCents: e.lines.reduce((s, l) => s + l.debitCents, 0),
        totalCreditCents: e.lines.reduce((s, l) => s + l.creditCents, 0),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);

ledgerRouter.get(
  "/journal-entries/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: { include: { account: true } } },
    });
    if (!entry) throw notFound("Journal entry not found");
    res.json(entry);
  })
);

/**
 * Unpost. Allowed only while nothing references the entry — the scope permits
 * unposting a transaction "if it is not connected to other transactions".
 */
ledgerRouter.post(
  "/journal-entries/:id/unpost",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    // unpostEntry walks forward from the document this entry belongs to and
    // refuses when anything depends on it, so no allowlist is needed here.
    const entry = await prisma.$transaction((tx) => unpostEntry(tx, id));
    res.json(entry);
  })
);

/** Reverse a posted entry with a mirror-image contra entry. */
ledgerRouter.post(
  "/journal-entries/:id/reverse",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const reversal = await prisma.$transaction((tx) => reverseEntry(tx, id, { actor }));
    res.status(201).json(reversal);
  })
);

ledgerRouter.delete(
  "/journal-entries/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const current = await prisma.journalEntry.findUnique({ where: { id } });
    if (!current) throw notFound("Journal entry not found");
    if (current.status === "POSTED") {
      throw conflict("A posted entry cannot be deleted — reverse it instead");
    }
    // Unposting clears `status` and `postedAt`, so status alone cannot tell us
    // whether this entry was ever on the books. Once it has been, it stays.
    if (current.hasBeenPosted) {
      throw conflict(
        `${current.entryNumber} has been posted before and cannot be deleted — reverse it instead, so the history shows what happened`
      );
    }
    await prisma.journalEntry.delete({ where: { id } });
    res.json({ deleted: true });
  })
);

/**
 * GET /api/trial-balance?asOf=YYYY-MM-DD
 *
 * What is actually being proved here, stated carefully — because two of the
 * obvious candidates prove nothing.
 *
 * `totalDebitCents === totalCreditCents` cannot fail while every entry goes
 * through `createEntry`, which refuses an unbalanced one.
 *
 * The accounting equation is the SAME quantity wearing a disguise. Because
 * asset and expense accounts are debit-normal and liability, equity and income
 * accounts are credit-normal, `assets - (liabilities + equity + income -
 * expenses)` telescopes to exactly `totalDebits - totalCredits`. It is
 * reported for the reader's benefit but it is not evidence, and a comment
 * saying otherwise was wrong.
 *
 * These three can genuinely fail:
 *
 *  - `unbalancedEntries` — each entry re-proved on its own, which catches
 *    anything that wrote journal lines around the engine.
 *  - `chartInconsistencies` — an account whose normalSide disagrees with its
 *    accountType. That is a configuration bug the equation cannot see, and it
 *    silently inverts every balance on that account.
 *  - `orphanedReversals` — a posted reversal whose original has been deleted.
 *    The books are then moved by an entry with nothing to explain it, and no
 *    sum of debits and credits will ever notice.
 */
ledgerRouter.get(
  "/trial-balance",
  asyncHandler(async (req, res) => {
    const asOf = String(req.query.asOf ?? "").trim();
    const entryWhere = {
      status: "POSTED",
      ...(asOf ? { entryDate: { lte: new Date(`${asOf}T23:59:59.999Z`) } } : {}),
    };

    const lines = await prisma.journalLine.findMany({
      where: { journalEntry: entryWhere },
      include: { account: true, journalEntry: { select: { id: true, entryNumber: true } } },
    });

    const byAccount = new Map<
      number,
      { code: string; name: string; accountType: string; normalSide: string; debitCents: number; creditCents: number }
    >();
    // Per-entry totals, so each entry can be re-proved on its own.
    const byEntry = new Map<number, { entryNumber: string; debitCents: number; creditCents: number }>();

    for (const line of lines) {
      const account =
        byAccount.get(line.accountId) ??
        {
          code: line.account.code,
          name: line.account.name,
          accountType: line.account.accountType,
          normalSide: line.account.normalSide,
          debitCents: 0,
          creditCents: 0,
        };
      account.debitCents += line.debitCents;
      account.creditCents += line.creditCents;
      byAccount.set(line.accountId, account);

      const entry =
        byEntry.get(line.journalEntry.id) ??
        { entryNumber: line.journalEntry.entryNumber, debitCents: 0, creditCents: 0 };
      entry.debitCents += line.debitCents;
      entry.creditCents += line.creditCents;
      byEntry.set(line.journalEntry.id, entry);
    }

    const accounts = [...byAccount.values()]
      .map((a) => ({ ...a, balanceCents: balanceOf(a.normalSide, a) }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const unbalancedEntries = [...byEntry.entries()]
      .filter(([, e]) => e.debitCents !== e.creditCents)
      .map(([id, e]) => ({
        id,
        entryNumber: e.entryNumber,
        debitCents: e.debitCents,
        creditCents: e.creditCents,
      }));

    const totalFor = (types: string[]) =>
      accounts.filter((a) => types.includes(a.accountType)).reduce((s, a) => s + a.balanceCents, 0);

    const assetsCents = totalFor(["ASSET"]);
    const liabilitiesCents = totalFor(["LIABILITY"]);
    const equityCents = totalFor(["EQUITY"]);
    const incomeCents = totalFor(["INCOME"]);
    const expensesCents = totalFor(["EXPENSE"]);

    // Assets = Liabilities + Equity + Income - Expenses
    const equationVarianceCents =
      assetsCents - (liabilitiesCents + equityCents + incomeCents - expensesCents);

    const totalDebitCents = accounts.reduce((s, a) => s + a.debitCents, 0);
    const totalCreditCents = accounts.reduce((s, a) => s + a.creditCents, 0);

    // An account typed one way and signed the other inverts its whole balance.
    const EXPECTED_SIDE: Record<string, string> = {
      ASSET: "DEBIT",
      EXPENSE: "DEBIT",
      LIABILITY: "CREDIT",
      EQUITY: "CREDIT",
      INCOME: "CREDIT",
    };
    const allAccounts = await prisma.account.findMany({ orderBy: { code: "asc" } });
    const chartInconsistencies = allAccounts
      .filter((a) => EXPECTED_SIDE[a.accountType] && EXPECTED_SIDE[a.accountType] !== a.normalSide)
      .map((a) => ({
        code: a.code,
        name: a.name,
        accountType: a.accountType,
        normalSide: a.normalSide,
        expectedSide: EXPECTED_SIDE[a.accountType],
      }));

    // A reversal whose original is gone moves the books with no explanation.
    const reversals = await prisma.journalEntry.findMany({
      where: { transactionType: { endsWith: "_REVERSAL" }, status: "POSTED" },
    });
    const orphanedReversals: { entryNumber: string; transactionType: string }[] = [];
    for (const r of reversals) {
      const originalType = r.transactionType.replace(/_REVERSAL$/, "");
      const original = await prisma.journalEntry.findFirst({
        where: {
          transactionType: originalType,
          referenceType: r.referenceType,
          referenceId: r.referenceId,
        },
      });
      if (!original) {
        orphanedReversals.push({ entryNumber: r.entryNumber, transactionType: r.transactionType });
      }
    }

    res.json({
      asOf: asOf || null,
      accounts,
      totalDebitCents,
      totalCreditCents,
      entryCount: byEntry.size,
      unbalancedEntries,
      assetsCents,
      liabilitiesCents,
      equityCents,
      incomeCents,
      expensesCents,
      /**
       * Reported for the reader, NOT relied on: this is algebraically the same
       * number as totalDebits - totalCredits, so it cannot fail on its own.
       */
      equationVarianceCents,
      chartInconsistencies,
      orphanedReversals,
      /** True only when the three checks that can actually fail all pass. */
      sound:
        unbalancedEntries.length === 0 &&
        chartInconsistencies.length === 0 &&
        orphanedReversals.length === 0,
      /** Retained for compatibility; prefer `sound`. */
      balanced:
        unbalancedEntries.length === 0 &&
        chartInconsistencies.length === 0 &&
        orphanedReversals.length === 0,
    });
  })
);

/** GET /api/inventory-lots?productId=&warehouseId=&openOnly=true */
ledgerRouter.get(
  "/inventory-lots",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const productId = optionalInt(req.query.productId);
    const warehouseId = optionalInt(req.query.warehouseId);
    const openOnly = req.query.openOnly === "true";

    const where = {
      ...(productId ? { productId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(openOnly ? { remainingQty: { gt: 0 } } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.inventoryLot.count({ where }),
      prisma.inventoryLot.findMany({
        where,
        skip,
        take,
        include: { product: true, warehouse: true },
        // Oldest first: the order FIFO will consume them in.
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      }),
    ]);

    res.json({
      data: rows.map((l) => ({
        ...l,
        consumedQty: l.originalQty - l.remainingQty,
        remainingValueCents: l.remainingQty * l.unitCostCents,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);
