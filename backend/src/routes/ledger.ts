import { Router } from "express";
import { prisma } from "../db";
import { conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, optionalInt, pagination } from "../http";
import { requireMoney, requireStock } from "../auth";
import { balanceOf, dependenciesOf, repostEntry, reverseEntry, unpostEntry } from "../ledger";
import { getLockDate, setLockDate } from "../period";
import { trialBalance } from "../books";

export const ledgerRouter = Router();

/**
 * GET /api/journal-examples — every posting rule with the app's OWN evidence:
 * how many posted entries it has made and the latest one, lines and amounts.
 * The Accounting page shows the chart and its transactions from this, so what
 * it displays is this company's ledger, never sample figures.
 */
ledgerRouter.get(
  "/journal-examples",
  asyncHandler(async (_req, res) => {
    const [templates, accounts, counts, latest] = await Promise.all([
      prisma.journalTemplate.findMany({ orderBy: { transactionType: "asc" } }),
      prisma.account.findMany(),
      prisma.journalEntry.groupBy({ by: ["transactionType"], where: { status: "POSTED" }, _count: { _all: true } }),
      prisma.journalEntry.findMany({
        where: { status: "POSTED" },
        distinct: ["transactionType"],
        orderBy: [{ entryDate: "desc" }, { id: "desc" }],
        include: { lines: { include: { account: true }, orderBy: { id: "asc" } } },
      }),
    ]);
    const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
    res.json({
      data: templates.map((t) => {
        const e = latest.find((x) => x.transactionType === t.transactionType);
        return {
          transactionType: t.transactionType,
          description: t.description,
          debit: { code: t.debitAccountCode, name: nameOf(t.debitAccountCode) },
          credit: { code: t.creditAccountCode, name: nameOf(t.creditAccountCode) },
          postedCount: counts.find((c) => c.transactionType === t.transactionType)?._count._all ?? 0,
          latest: e
            ? {
                id: e.id,
                entryNumber: e.entryNumber,
                entryDate: e.entryDate,
                memo: e.memo,
                lines: e.lines.map((l) => ({
                  code: l.account.code,
                  name: l.account.name,
                  debitCents: l.debitCents,
                  creditCents: l.creditCents,
                })),
              }
            : null,
        };
      }),
    });
  })
);

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
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    // unpostEntry walks forward from the document this entry belongs to and
    // refuses when anything depends on it, so no allowlist is needed here.
    const entry = await prisma.$transaction((tx) => unpostEntry(tx, id));
    res.json(entry);
  })
);

/**
 * The period lock. GET reads it; PUT moves it, or clears it with a null date.
 *
 * This is the control that makes a reported period mean something: below the
 * lock date nothing can be posted, unposted, re-posted or reversed.
 */
ledgerRouter.get(
  "/ledger-settings",
  asyncHandler(async (_req, res) => {
    const lockDate = await getLockDate();
    res.json({ lockDate: lockDate ? lockDate.toISOString() : null });
  })
);

ledgerRouter.put(
  "/ledger-settings/lock-date",
  requireMoney,
  asyncHandler(async (req, res) => {
    const raw = req.body?.lockDate;
    const lockDate = await setLockDate(raw === null || raw === "" ? null : String(raw));
    res.json({ lockDate: lockDate ? lockDate.toISOString() : null });
  })
);

/** Re-post an entry that was unposted, so unposting is not a one-way door. */
ledgerRouter.post(
  "/journal-entries/:id/post",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const entry = await prisma.$transaction((tx) => repostEntry(tx, id));
    res.json(entry);
  })
);

/**
 * Reverse a posted entry with a mirror-image contra entry.
 *
 * The dependency check lives HERE and not inside `reverseEntry`, because the
 * two callers are not alike. `reverseDocumentEntry` is used by the cancel and
 * void flows in salesOrders, purchaseOrders and stockTransfers, which reverse
 * the physical movement first and then the ledger — for those, a SHIPMENT or
 * STOCK_TRANSFER reference is exactly what they are entitled to reverse, and
 * putting the guard in `reverseEntry` would break transfer cancellation.
 *
 * This endpoint has done no such thing. A GL-only mirror of a shipment entry
 * credits COGS and re-debits Inventory for stock that has physically left,
 * leaving the ledger overstating inventory against unchanged FIFO layers.
 */
ledgerRouter.post(
  "/journal-entries/:id/reverse",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const reversal = await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.findUnique({ where: { id } });
      if (!entry) throw notFound("Journal entry not found");
      const blocker = await dependenciesOf(tx, entry);
      if (blocker) {
        throw conflict(
          `${entry.entryNumber} cannot be reversed from the ledger: ${blocker}. ` +
            `Cancel or void the document instead, so the stock moves back too.`
        );
      }
      return reverseEntry(tx, id, { actor });
    });
    res.status(201).json(reversal);
  })
);

ledgerRouter.delete(
  "/journal-entries/:id",
  requireStock,
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
    res.json(await trialBalance(String(req.query.asOf ?? "").trim()));
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
