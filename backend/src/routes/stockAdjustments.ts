import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest } from "../errors";
import { actorOf, asyncHandler, optionalInt, pagination, parseBody } from "../http";
import { requireStock } from "../auth";
import { applyBalanceDelta, recordMovement } from "../inventory";
import { consumeSerials, SERIAL_STATUS } from "../serials";
import { consumeFifo, createLot } from "../costing";
import { postSimple } from "../ledger";
import { TRANSACTION_TYPE } from "../accounts";
import { ADJUSTMENT_TYPES } from "../domain";
import { assertReferencesUsable } from "../refs";

export const stockAdjustmentsRouter = Router();

const createSchema = z.object({
  productId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  adjustmentType: z.enum(ADJUSTMENT_TYPES),
  quantity: z.number().int().positive(),
  reason: z.string().min(1, "A reason is required so the audit trail stays useful"),
  /// Only meaningful on an INCREASE: what the stock being written on is worth.
  /// A DECREASE is always valued at the FIFO cost of the layers it consumes.
  unitCostCents: z.number().int().min(0).optional(),
  /// Required on a DECREASE for a SERIAL-tracked product. "One of these is
  /// broken" is not a record anyone can act on later, and for a warranty claim
  /// against the vendor the serial IS the claim.
  serialNumbers: z.array(z.string().trim().min(1)).optional(),
});

stockAdjustmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const productId = optionalInt(req.query.productId);
    const warehouseId = optionalInt(req.query.warehouseId);

    const where = {
      ...(productId ? { productId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.stockAdjustment.count({ where }),
      prisma.stockAdjustment.findMany({
        where,
        skip,
        take,
        include: { product: true, warehouse: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

stockAdjustmentsRouter.post(
  "/",
  requireStock,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const actor = actorOf(req);

    const adjustment = await prisma.$transaction(async (tx) => {
      const { products, warehouses } = await assertReferencesUsable(tx, [
        { productId: body.productId, warehouseId: body.warehouseId },
      ]);
      const product = products[0];
      const warehouse = warehouses[0];

      const increase = body.adjustmentType === "INCREASE";
      const signed = increase ? body.quantity : -body.quantity;

      await applyBalanceDelta(
        tx,
        body.productId,
        body.warehouseId,
        { onHandQty: signed },
        `Cannot adjust ${product.sku} at ${warehouse.code}`
      );

      const adjustment = await tx.stockAdjustment.create({
        data: {
          productId: body.productId,
          warehouseId: body.warehouseId,
          adjustmentType: body.adjustmentType,
          quantity: body.quantity,
          reason: body.reason,
          actor,
        },
        include: { product: true, warehouse: true },
      });

      // An increase creates a layer at the cost given (falling back to the
      // product's default); a decrease consumes the oldest layers and is
      // valued at exactly what they cost.
      let totalCostCents: number;
      if (increase) {
        const unitCostCents = body.unitCostCents ?? product.defaultCostCents;
        totalCostCents = unitCostCents * body.quantity;
        await createLot(tx, {
          productId: body.productId,
          warehouseId: body.warehouseId,
          quantity: body.quantity,
          unitCostCents,
          sourceType: "STOCK_ADJUSTMENT",
          sourceId: adjustment.id,
        });
      } else if (product.trackingMode === "SERIAL") {
        // 🔴 A serialized write-off must say WHICH unit. consumeFifo would pick
        // the oldest layer, scrap a correct quantity, and leave the records
        // claiming a different physical unit was destroyed — invisible until a
        // vendor warranty claim needs the serial.
        const named = body.serialNumbers ?? [];
        if (named.length !== body.quantity) {
          throw badRequest(
            `${product.sku} is serial-tracked — name the ${body.quantity} unit(s) being adjusted ` +
              `(${named.length} given)`,
            { action: "scan-serials", productId: body.productId, quantity: body.quantity }
          );
        }
        const consumed = await consumeSerials(tx, {
          productId: body.productId,
          warehouseId: body.warehouseId,
          serialNumbers: named,
          sourceType: "STOCK_ADJUSTMENT",
          sourceId: adjustment.id,
          context: `Cannot adjust ${product.sku} at ${warehouse.code}`,
          toStatus: SERIAL_STATUS.SCRAPPED,
        });
        totalCostCents = consumed.totalCostCents;
      } else {
        const consumed = await consumeFifo(tx, {
          productId: body.productId,
          warehouseId: body.warehouseId,
          quantity: body.quantity,
          sourceType: "STOCK_ADJUSTMENT",
          sourceId: adjustment.id,
          context: `Cannot cost ${product.sku} at ${warehouse.code}`,
        });
        totalCostCents = consumed.totalCostCents;
      }

      await recordMovement(tx, {
        productId: body.productId,
        fromWarehouseId: increase ? null : body.warehouseId,
        toWarehouseId: increase ? body.warehouseId : null,
        quantity: body.quantity,
        movementType: increase ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
        reason: body.reason,
        referenceType: "STOCK_ADJUSTMENT",
        referenceId: adjustment.id,
        totalCostCents,
        actor,
      });

      if (totalCostCents > 0) {
        await postSimple(tx, {
          transactionType: increase
            ? TRANSACTION_TYPE.ADJUSTMENT_INCREASE
            : TRANSACTION_TYPE.ADJUSTMENT_DECREASE,
          amountCents: totalCostCents,
          memo: `${adjustment.adjustmentType} ${product.sku} at ${warehouse.code}: ${body.reason}`,
          referenceType: "STOCK_ADJUSTMENT",
          referenceId: adjustment.id,
          actor,
          productId: body.productId,
          debitWarehouseId: body.warehouseId,
          creditWarehouseId: body.warehouseId,
        });
      }

      return { ...adjustment, totalCostCents };
    });

    res.status(201).json(adjustment);
  })
);
