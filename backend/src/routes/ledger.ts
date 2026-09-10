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
      throw conflict("A posted entry cannot be deleted — unpost it first");
    }
    await prisma.journalEntry.delete({ where: { id } });
    res.json({ deleted: true });
  })
);

/**
 * GET /api/trial-balance?asOf=YYYY-MM-DD
 *
 * Note on what is actually being proved here.
 *
 * Summing every debit against every credit CANNOT fail while all entries go
 * through `createEntry`, which refuses an unbalanced one — so that total on
 * its own is decorative, not a check. Two things that can genuinely fail are
 * reported instead:
 *
 *  - `unbalancedEntries`: each entry re-checked independently, which catches
 *    anything that wrote journal lines without going through the engine.
 *  - `equationVarianceCents`: the accounting equation, assets = liabilities +
 *    equity + income - expenses. This fails when entries are individually
 *    balanced but post to the wrong SIDE of the books — the failure a
 *    debit-equals-credit total is blind to.
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
      equationVarianceCents,
      /** True only when every entry balances AND the equation holds. */
      balanced:
        unbalancedEntries.length === 0 &&
        equationVarianceCents === 0 &&
        totalDebitCents === totalCreditCents,
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
