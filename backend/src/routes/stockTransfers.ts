import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, optionalInt, pagination, parseBody } from "../http";
import { applyBalanceDelta, claimStatusTransition, recordMovement } from "../inventory";
import { attachConsumptionsToMovement, consumeFifo, createLot } from "../costing";
import { ACCOUNT, TRANSACTION_TYPE } from "../accounts";
import { createEntry, reverseDocumentEntry } from "../ledger";
import { assertReferencesUsable } from "../refs";

export const stockTransfersRouter = Router();

const createSchema = z
  .object({
    productId: z.number().int().positive(),
    fromWarehouseId: z.number().int().positive(),
    toWarehouseId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    notes: z.string().optional().nullable(),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: "Source and destination warehouses must differ",
    path: ["toWarehouseId"],
  });

const include = { product: true, fromWarehouse: true, toWarehouse: true };

stockTransfersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const status = String(req.query.status ?? "").trim();
    const warehouseId = optionalInt(req.query.warehouseId);

    const where = {
      ...(status ? { status } : {}),
      ...(warehouseId
        ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.stockTransfer.count({ where }),
      prisma.stockTransfer.findMany({
        where,
        skip,
        take,
        include,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

stockTransfersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const transfer = await prisma.stockTransfer.findUnique({ where: { id }, include });
    if (!transfer) throw notFound("Transfer not found");
    res.json(transfer);
  })
);

stockTransfersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    await assertReferencesUsable(prisma, [
      { productId: body.productId, warehouseId: body.fromWarehouseId },
      { productId: body.productId, warehouseId: body.toWarehouseId },
    ]);
    const actor = actorOf(req);
    const transfer = await prisma.stockTransfer.create({
      data: { ...body, notes: body.notes ?? null, status: "DRAFT", actor },
      include,
    });
    res.status(201).json(transfer);
  })
);

/** START pulls stock out of the source warehouse; it is in transit, owned by neither side. */
stockTransfersRouter.post(
  "/:id/start",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const transfer = await prisma.$transaction(async (tx) => {
      const current = await tx.stockTransfer.findUnique({ where: { id }, include });
      if (!current) throw notFound("Transfer not found");
      if (current.status !== "DRAFT")
        throw conflict(`Only DRAFT transfers can be started (this one is ${current.status})`);

      // Claim the transition atomically so two concurrent calls cannot both
      // process the same document.
      const claimed = await claimStatusTransition(
        (args) => tx.stockTransfer.updateMany(args),
        id,
        "DRAFT",
        "IN_TRANSIT"
      );
      if (!claimed) throw conflict("This transfer was already started by another request");

      await applyBalanceDelta(
        tx,
        current.productId,
        current.fromWarehouseId,
        { onHandQty: -current.quantity },
        `Cannot move ${current.product.sku} out of ${current.fromWarehouse.code}`
      );

      // Consume the source layers now. The cost travels with the goods and is
      // recreated at the destination on completion, so FIFO order survives the
      // move instead of being averaged away.
      const consumed = await consumeFifo(tx, {
        productId: current.productId,
        warehouseId: current.fromWarehouseId,
        quantity: current.quantity,
        sourceType: "STOCK_TRANSFER",
        sourceId: current.id,
        context: `Cannot cost ${current.product.sku} at ${current.fromWarehouse.code}`,
      });

      // Only the SOURCE side. The goods have left one warehouse and not yet
      // arrived at the other, so crediting the destination here would report
      // stock in two places at once (and double-count it on completion).
      const outMovement = await recordMovement(tx, {
        productId: current.productId,
        fromWarehouseId: current.fromWarehouseId,
        quantity: current.quantity,
        movementType: "TRANSFER_OUT",
        reason:
          current.notes ??
          `Transfer #${current.id} dispatched to ${current.toWarehouse.code}`,
        referenceType: "STOCK_TRANSFER",
        referenceId: current.id,
        totalCostCents: consumed.totalCostCents,
        actor,
      });
      await attachConsumptionsToMovement(tx, consumed.consumptionIds, outMovement.id);

      // Both sides are Inventory, so the entry is warehouse-to-warehouse
      // within one account rather than a template pair.
      await createEntry(tx, {
        transactionType: TRANSACTION_TYPE.INVENTORY_TRANSFER,
        memo: `Transfer #${current.id}: ${current.fromWarehouse.code} to ${current.toWarehouse.code}`,
        referenceType: "STOCK_TRANSFER",
        referenceId: current.id,
        actor,
        lines: [
          {
            accountCode: ACCOUNT.INVENTORY,
            debitCents: consumed.totalCostCents,
            productId: current.productId,
            warehouseId: current.toWarehouseId,
            memo: `Into ${current.toWarehouse.code}`,
          },
          {
            accountCode: ACCOUNT.INVENTORY,
            creditCents: consumed.totalCostCents,
            productId: current.productId,
            warehouseId: current.fromWarehouseId,
            memo: `Out of ${current.fromWarehouse.code}`,
          },
        ],
      });

      await tx.stockTransfer.update({
        where: { id },
        data: { costCents: consumed.totalCostCents },
      });

      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(transfer);
  })
);

/** COMPLETE lands the in-transit stock in the destination warehouse. */
stockTransfersRouter.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const transfer = await prisma.$transaction(async (tx) => {
      const current = await tx.stockTransfer.findUnique({ where: { id }, include });
      if (!current) throw notFound("Transfer not found");
      if (current.status !== "IN_TRANSIT")
        throw conflict(`Only IN_TRANSIT transfers can be completed (this one is ${current.status})`);

      // Claim the transition atomically so two concurrent calls cannot both
      // process the same document.
      const claimed = await claimStatusTransition(
        (args) => tx.stockTransfer.updateMany(args),
        id,
        "IN_TRANSIT",
        "COMPLETED"
      );
      if (!claimed) throw conflict("This transfer was already completed by another request");

      await applyBalanceDelta(
        tx,
        current.productId,
        current.toWarehouseId,
        { onHandQty: current.quantity },
        `Cannot receive ${current.product.sku} into ${current.toWarehouse.code}`
      );

      // Recreate the layers the source gave up, at the same unit costs. The
      // slices were recorded as LotConsumption rows when the transfer started.
      // Recreate the layers the source gave up, at their original unit costs
      // AND their original receipt dates, so the stock does not become
      // artificially young and jump the FIFO queue at its new home.
      const slices = await tx.lotConsumption.findMany({
        where: { sourceType: "STOCK_TRANSFER", sourceId: current.id },
        include: { lot: { select: { receivedAt: true } } },
        orderBy: { id: "asc" },
      });
      for (const slice of slices) {
        await createLot(tx, {
          productId: current.productId,
          warehouseId: current.toWarehouseId,
          quantity: slice.quantity,
          unitCostCents: slice.unitCostCents,
          receivedAt: slice.lot.receivedAt,
          sourceType: "STOCK_TRANSFER",
          sourceId: current.id,
        });
      }

      // Only the DESTINATION side — the source was already debited on start.
      await recordMovement(tx, {
        productId: current.productId,
        toWarehouseId: current.toWarehouseId,
        quantity: current.quantity,
        movementType: "TRANSFER_IN",
        reason:
          current.notes ??
          `Transfer #${current.id} received from ${current.fromWarehouse.code}`,
        referenceType: "STOCK_TRANSFER",
        referenceId: current.id,
        totalCostCents: current.costCents,
        actor,
      });

      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(transfer);
  })
);

/** A DRAFT transfer can be dropped outright; an IN_TRANSIT one returns stock to the source. */
stockTransfersRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const transfer = await prisma.$transaction(async (tx) => {
      const current = await tx.stockTransfer.findUnique({ where: { id }, include });
      if (!current) throw notFound("Transfer not found");
      if (current.status === "COMPLETED") throw conflict("A completed transfer cannot be canceled");
      if (current.status === "CANCELED") throw conflict("Transfer is already canceled");

      // Claim the transition atomically so two concurrent calls cannot both
      // process the same document.
      const claimed = await claimStatusTransition(
        (args) => tx.stockTransfer.updateMany(args),
        id,
        current.status,
        "CANCELED"
      );
      if (!claimed) throw conflict("This transfer was already changed by another request");

      if (current.status === "IN_TRANSIT") {
        await applyBalanceDelta(
          tx,
          current.productId,
          current.fromWarehouseId,
          { onHandQty: current.quantity },
          `Cannot return ${current.product.sku} to ${current.fromWarehouse.code}`
        );
        // Restore the layers to the warehouse the stock came from.
        const slices = await tx.lotConsumption.findMany({
          where: { sourceType: "STOCK_TRANSFER", sourceId: current.id },
          include: { lot: { select: { receivedAt: true } } },
          orderBy: { id: "asc" },
        });
        for (const slice of slices) {
          await createLot(tx, {
            productId: current.productId,
            warehouseId: current.fromWarehouseId,
            quantity: slice.quantity,
            unitCostCents: slice.unitCostCents,
            receivedAt: slice.lot.receivedAt,
            sourceType: "STOCK_TRANSFER_CANCEL",
            sourceId: current.id,
          });
        }

        await recordMovement(tx, {
          productId: current.productId,
          toWarehouseId: current.fromWarehouseId,
          quantity: current.quantity,
          movementType: "TRANSFER_IN",
          reason: `Transfer #${current.id} canceled in transit, stock returned`,
          referenceType: "STOCK_TRANSFER",
          referenceId: current.id,
          totalCostCents: current.costCents,
          actor,
        });

        // The start posted Dr Inventory(dest) / Cr Inventory(source). Without
        // a reversal the destination keeps a debit for stock it never got.
        await reverseDocumentEntry(tx, "STOCK_TRANSFER", current.id, {
          actor,
          memo: `Transfer #${current.id} canceled in transit`,
        });
      }

      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(transfer);
  })
);

stockTransfersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const current = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!current) throw notFound("Transfer not found");
    if (current.status !== "DRAFT" && current.status !== "CANCELED")
      throw badRequest("Only DRAFT or CANCELED transfers can be deleted");
    await prisma.stockTransfer.delete({ where: { id } });
    res.json({ deleted: true });
  })
);
