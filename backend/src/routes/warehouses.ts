import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { notFound } from "../errors";
import { asyncHandler, intParam, parseBody } from "../http";

export const warehousesRouter = Router();

const warehouseSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  address: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

warehousesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === "true";
    const warehouses = await prisma.warehouse.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { name: "asc" },
      include: { balances: true },
    });
    res.json({
      data: warehouses.map(({ balances, ...w }) => ({
        ...w,
        skuCount: balances.filter((b) => b.onHandQty !== 0).length,
        totalOnHand: balances.reduce((s, b) => s + b.onHandQty, 0),
        totalReserved: balances.reduce((s, b) => s + b.reservedQty, 0),
        totalIncoming: balances.reduce((s, b) => s + b.incomingQty, 0),
      })),
    });
  })
);

warehousesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const warehouse = await prisma.warehouse.findUnique({
      where: { id },
      include: { balances: { include: { product: true }, orderBy: { productId: "asc" } } },
    });
    if (!warehouse) throw notFound("Warehouse not found");
    const { balances, ...rest } = warehouse;
    res.json({
      ...rest,
      balances: balances.map((b) => ({ ...b, availableQty: b.onHandQty - b.reservedQty })),
      totalOnHand: balances.reduce((s, b) => s + b.onHandQty, 0),
    });
  })
);

warehousesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = parseBody(warehouseSchema, req.body);
    res.status(201).json(await prisma.warehouse.create({ data }));
  })
);

warehousesRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const data = parseBody(warehouseSchema.partial(), req.body);
    const existing = await prisma.warehouse.findUnique({ where: { id } });
    if (!existing) throw notFound("Warehouse not found");
    res.json(await prisma.warehouse.update({ where: { id }, data }));
  })
);

/** Refuses to delete a warehouse that still holds stock; deactivates instead. */
warehousesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    // Counting and deleting in one transaction, so a concurrent write cannot
    // make the delete illegal between the check and the delete itself.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.warehouse.findUnique({ where: { id } });
      if (!existing) throw notFound("Warehouse not found");

      // Every table that points at a warehouse has to be clear before the row
      // can go, otherwise the delete fails on a foreign key.
      const referenceCounts = await Promise.all([
        tx.inventoryBalance.count({
          where: { warehouseId: id, OR: [{ onHandQty: { not: 0 } }, { reservedQty: { not: 0 } }, { incomingQty: { not: 0 } }] },
        }),
        tx.salesOrderLine.count({ where: { warehouseId: id } }),
        tx.purchaseOrderLine.count({ where: { warehouseId: id } }),
        tx.stockTransfer.count({
          where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] },
        }),
        tx.stockAdjustment.count({ where: { warehouseId: id } }),
        tx.inventoryMovement.count({
          where: { OR: [{ fromWarehouseId: id }, { toWarehouseId: id }] },
        }),
      ]);

      if (referenceCounts.reduce((a, b) => a + b, 0) === 0) {
        await tx.inventoryBalance.deleteMany({ where: { warehouseId: id } });
        await tx.warehouse.delete({ where: { id } });
        return { deleted: true, soft: false };
      }
      await tx.warehouse.update({ where: { id }, data: { isActive: false } });
      return { deleted: true, soft: true };
    });

    res.json(result);
  })
);
