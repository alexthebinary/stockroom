import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, optionalInt } from "../http";
import { LOW_STOCK_THRESHOLD } from "../domain";

export const dashboardRouter = Router();

/** GET /api/dashboard?lowStockThreshold=10 */
dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const threshold = optionalInt(req.query.lowStockThreshold) ?? LOW_STOCK_THRESHOLD;

    const [
      productCount,
      activeProductCount,
      warehouseCount,
      balanceTotals,
      lowStockRows,
      recentMovements,
      openSalesOrders,
      openPurchaseOrders,
      transfersInTransit,
    ] = await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { isActive: true } }),
      prisma.warehouse.count({ where: { isActive: true } }),
      prisma.inventoryBalance.aggregate({
        _sum: { onHandQty: true, reservedQty: true, incomingQty: true },
      }),
      prisma.inventoryBalance.findMany({
        where: { onHandQty: { lt: threshold }, product: { isActive: true } },
        include: { product: true, warehouse: true },
        orderBy: { onHandQty: "asc" },
        take: 20,
      }),
      prisma.inventoryMovement.findMany({
        include: { product: true, fromWarehouse: true, toWarehouse: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
      }),
      prisma.salesOrder.count({
        where: { readinessStatus: { in: ["NOT_PACKED", "PACKED"] } },
      }),
      prisma.purchaseOrder.count({ where: { status: { in: ["SAVED", "POSTED", "PAID"] } } }),
      prisma.stockTransfer.count({ where: { status: "IN_TRANSIT" } }),
    ]);

    const onHand = balanceTotals._sum.onHandQty ?? 0;
    const reserved = balanceTotals._sum.reservedQty ?? 0;

    res.json({
      lowStockThreshold: threshold,
      totals: {
        productCount,
        activeProductCount,
        warehouseCount,
        onHandUnits: onHand,
        reservedUnits: reserved,
        incomingUnits: balanceTotals._sum.incomingQty ?? 0,
        availableUnits: onHand - reserved,
        openSalesOrders,
        openPurchaseOrders,
        transfersInTransit,
      },
      lowStock: lowStockRows.map((b) => ({ ...b, availableQty: b.onHandQty - b.reservedQty })),
      recentMovements,
    });
  })
);
