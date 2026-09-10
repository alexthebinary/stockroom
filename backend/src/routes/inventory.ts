import { Router } from "express";
import { prisma } from "../db";
import { contains } from "../search";
import { notFound } from "../errors";
import { asyncHandler, intParam, optionalInt, orderByFrom, pagination } from "../http";
import { withAvailable } from "../inventory";

export const inventoryRouter = Router();

/** GET /api/inventory?warehouseId=&productId=&search=&lowStockBelow= */
inventoryRouter.get(
  "/inventory",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const productId = optionalInt(req.query.productId);
    const warehouseId = optionalInt(req.query.warehouseId);
    const lowStockBelow = optionalInt(req.query.lowStockBelow);
    const search = String(req.query.search ?? "").trim();

    const where = {
      ...(productId ? { productId } : {}),
      ...(warehouseId ? { warehouseId } : {}),
      ...(lowStockBelow !== undefined ? { onHandQty: { lt: lowStockBelow } } : {}),
      ...(search
        ? { product: { OR: [{ sku: contains(search) }, { name: contains(search) }] } }
        : {}),
    };

    const orderBy = orderByFrom(
      req.query as Record<string, unknown>,
      {
        sku: [{ product: { sku: "__dir__" } }],
        name: [{ product: { name: "__dir__" } }],
        warehouse: [{ warehouse: { code: "__dir__" } }],
        onHandQty: [{ onHandQty: "__dir__" }],
        reservedQty: [{ reservedQty: "__dir__" }],
        incomingQty: [{ incomingQty: "__dir__" }],
        reorderPoint: [{ reorderPoint: "__dir__" }],
      } as Record<string, object[]>,
      [{ productId: "asc" }, { warehouseId: "asc" }] as object[]
    );

    const [total, rows] = await Promise.all([
      prisma.inventoryBalance.count({ where }),
      prisma.inventoryBalance.findMany({
        where,
        skip,
        take,
        include: { product: true, warehouse: true },
        orderBy: orderBy as never,
      }),
    ]);

    res.json({ data: rows.map(withAvailable), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

/** GET /api/inventory/:productId/warehouses — stock for one product, per warehouse. */
inventoryRouter.get(
  "/inventory/:productId/warehouses",
  asyncHandler(async (req, res) => {
    const productId = intParam(req.params.productId, "productId");
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw notFound("Product not found");

    const rows = await prisma.inventoryBalance.findMany({
      where: { productId },
      include: { warehouse: true },
      orderBy: { warehouseId: "asc" },
    });
    res.json({ product, data: rows.map(withAvailable) });
  })
);

/** GET /api/inventory-movements?productId=&warehouseId=&movementType= */
inventoryRouter.get(
  "/inventory-movements",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const productId = optionalInt(req.query.productId);
    const warehouseId = optionalInt(req.query.warehouseId);
    const movementType = String(req.query.movementType ?? "").trim();

    const where = {
      ...(productId ? { productId } : {}),
      ...(warehouseId
        ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] }
        : {}),
      ...(movementType ? { movementType } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.findMany({
        where,
        skip,
        take,
        include: { product: true, fromWarehouse: true, toWarehouse: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);
