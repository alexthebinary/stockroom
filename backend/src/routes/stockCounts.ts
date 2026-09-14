import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { requireStock } from "../auth";
import { applyBalanceDelta, recordMovement } from "../inventory";
import { consumeFifo, createLot } from "../costing";
import { postSimple } from "../ledger";
import { TRANSACTION_TYPE } from "../accounts";
import { nextStockCountNumber } from "../numbering";

export const stockCountsRouter = Router();

const include = {
  warehouse: true,
  lines: { include: { product: true }, orderBy: { id: "asc" } },
} as const;

/**
 * Physical stock counts.
 *
 * A count is a SESSION, not a pile of adjustments: open it and the system
 * freezes what it believes, someone walks the aisles, and the difference posts
 * once. Recording the same thing as individual adjustments loses that these
 * were one count, writes a journal entry per SKU, and cannot answer "what did
 * we find on the 30th".
 */

stockCountsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const status = String(req.query.status ?? "").trim();
    const where = status ? { status } : {};
    const [data, total] = await Promise.all([
      prisma.stockCount.findMany({
        where,
        include,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      prisma.stockCount.count({ where }),
    ]);
    res.json({ data, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

stockCountsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const count = await prisma.stockCount.findUnique({
      where: { id: intParam(req.params.id, "id") },
      include,
    });
    if (!count) throw notFound("Stock count not found");
    res.json(count);
  })
);

const createSchema = z.object({
  warehouseId: z.number().int().positive(),
  notes: z.string().trim().optional().nullable(),
  /// Omit to count everything currently held in the warehouse.
  productIds: z.array(z.number().int().positive()).optional(),
});

/**
 * Open a count. This is where expectations are frozen.
 */
stockCountsRouter.post(
  "/",
  requireStock,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const actor = actorOf(req);
    const warehouse = await prisma.warehouse.findUnique({ where: { id: body.warehouseId } });
    if (!warehouse) throw notFound("Warehouse not found");
    if (!warehouse.isActive) throw badRequest("That warehouse is deactivated");

    const count = await prisma.$transaction(async (tx) => {
      const balances = await tx.inventoryBalance.findMany({
        where: {
          warehouseId: body.warehouseId,
          ...(body.productIds?.length ? { productId: { in: body.productIds } } : {}),
        },
      });
      // A count of nothing is a mistake, not an empty session — it usually
      // means the wrong warehouse was picked.
      if (balances.length === 0) {
        throw badRequest("Nothing is stocked in that warehouse, so there is nothing to count");
      }

      return tx.stockCount.create({
        data: {
          countNumber: await nextStockCountNumber(tx),
          warehouseId: body.warehouseId,
          notes: body.notes ?? null,
          actor,
          lines: {
            create: balances.map((b) => ({ productId: b.productId, expectedQty: b.onHandQty })),
          },
        },
        include,
      });
    });

    res.status(201).json(count);
  })
);

const countSchema = z.object({
  lines: z.array(
    z.object({
      productId: z.number().int().positive(),
      // Null clears a count back to "not counted", which is different from zero.
      countedQty: z.number().int().min(0).nullable(),
    })
  ),
});

/** Record what was actually on the shelf. Repeatable while the count is open. */
stockCountsRouter.post(
  "/:id/lines",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const body = parseBody(countSchema, req.body);

    const count = await prisma.$transaction(async (tx) => {
      const current = await tx.stockCount.findUnique({ where: { id }, include });
      if (!current) throw notFound("Stock count not found");
      if (current.status !== "DRAFT") {
        throw conflict(`This count is ${current.status.toLowerCase()} and can no longer be edited`);
      }
      for (const line of body.lines) {
        const target = current.lines.find((l) => l.productId === line.productId);
        if (!target) throw badRequest(`Product ${line.productId} is not part of this count`);
        await tx.stockCountLine.update({
          where: { id: target.id },
          data: { countedQty: line.countedQty },
        });
      }
      return tx.stockCount.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(count);
  })
);

/**
 * Post the count: move stock to what was found, and book the difference.
 *
 * ONE journal entry for the whole session, split into a write-on and a
 * write-off leg, because a count that finds two crates and loses one is two
 * different accounting facts and netting them hides both.
 */
stockCountsRouter.post(
  "/:id/post",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.stockCount.findUnique({ where: { id }, include });
      if (!current) throw notFound("Stock count not found");
      if (current.status !== "DRAFT") throw conflict(`This count is already ${current.status.toLowerCase()}`);

      const counted = current.lines.filter((l) => l.countedQty !== null);
      if (counted.length === 0) {
        throw badRequest("Nothing has been counted yet");
      }
      // Uncounted lines are left alone rather than assumed correct. Posting a
      // partial count is normal; silently confirming stock nobody looked at is
      // how a count launders a guess into a fact.
      const variances = counted.filter((l) => l.countedQty !== l.expectedQty);

      const claimed = await tx.stockCount.updateMany({
        where: { id, status: "DRAFT" },
        data: { status: "POSTED", postedAt: new Date() },
      });
      if (claimed.count === 0) throw conflict("This count was already posted");

      let gainCents = 0;
      let lossCents = 0;

      for (const line of variances) {
        const delta = line.countedQty! - line.expectedQty;

        if (delta > 0) {
          // Found stock. It has no purchase behind it, so it is valued at the
          // most recent cost known for that product in this warehouse; failing
          // that, it comes on at zero rather than inventing a price.
          const recent = await tx.inventoryLot.findFirst({
            where: { productId: line.productId, warehouseId: current.warehouseId },
            orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          });
          const unitCostCents = recent?.unitCostCents ?? 0;
          const valueCents = delta * unitCostCents;

          await applyBalanceDelta(
            tx,
            line.productId,
            current.warehouseId,
            { onHandQty: delta },
            `Count ${current.countNumber}`
          );
          if (unitCostCents > 0) {
            await createLot(tx, {
              productId: line.productId,
              warehouseId: current.warehouseId,
              quantity: delta,
              unitCostCents,
              sourceType: "STOCK_COUNT",
              sourceId: current.id,
            });
          }
          await recordMovement(tx, {
            productId: line.productId,
            toWarehouseId: current.warehouseId,
            quantity: delta,
            movementType: "ADJUSTMENT_IN",
            reason: `Count ${current.countNumber}: found ${delta}`,
            referenceType: "STOCK_COUNT",
            referenceId: current.id,
            totalCostCents: valueCents,
            actor,
          });
          gainCents += valueCents;
        } else {
          const short = -delta;
          const consumed = await consumeFifo(tx, {
            productId: line.productId,
            warehouseId: current.warehouseId,
            quantity: short,
            sourceType: "STOCK_COUNT",
            sourceId: current.id,
            context: `Count ${current.countNumber}`,
          });
          await applyBalanceDelta(
            tx,
            line.productId,
            current.warehouseId,
            { onHandQty: delta },
            `Count ${current.countNumber}`
          );
          await recordMovement(tx, {
            productId: line.productId,
            fromWarehouseId: current.warehouseId,
            quantity: short,
            movementType: "ADJUSTMENT_OUT",
            reason: `Count ${current.countNumber}: short ${short}`,
            referenceType: "STOCK_COUNT",
            referenceId: current.id,
            totalCostCents: consumed.totalCostCents,
            actor,
          });
          lossCents += consumed.totalCostCents;
        }
      }

      // Two legs, not a net figure: a count that finds stock AND loses stock
      // has done both, and a single netted number reports neither.
      const entries = [];
      if (gainCents > 0) {
        entries.push(
          await postSimple(tx, {
            transactionType: TRANSACTION_TYPE.ADJUSTMENT_INCREASE,
            amountCents: gainCents,
            memo: `Count ${current.countNumber}: stock found`,
            referenceType: "STOCK_COUNT",
            referenceId: current.id,
            actor,
          })
        );
      }
      if (lossCents > 0) {
        entries.push(
          await postSimple(tx, {
            transactionType: TRANSACTION_TYPE.ADJUSTMENT_DECREASE,
            amountCents: lossCents,
            memo: `Count ${current.countNumber}: stock short`,
            referenceType: "STOCK_COUNT",
            referenceId: current.id,
            actor,
          })
        );
      }

      return {
        count: await tx.stockCount.findUniqueOrThrow({ where: { id }, include }),
        counted: counted.length,
        uncounted: current.lines.length - counted.length,
        variances: variances.length,
        gainCents,
        lossCents,
        entries: entries.filter(Boolean).length,
      };
    });

    res.json(result);
  })
);

/** Abandon an open count. Nothing has been posted, so nothing is reversed. */
stockCountsRouter.post(
  "/:id/cancel",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const current = await prisma.stockCount.findUnique({ where: { id } });
    if (!current) throw notFound("Stock count not found");
    if (current.status !== "DRAFT") throw conflict(`This count is already ${current.status.toLowerCase()}`);
    const count = await prisma.stockCount.update({
      where: { id },
      data: { status: "CANCELED" },
      include,
    });
    res.json(count);
  })
);
