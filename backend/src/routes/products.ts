import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { notFound } from "../errors";
import { asyncHandler, intParam, pagination, parseBody } from "../http";

export const productsRouter = Router();

const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  length: z.number().nonnegative().optional().nullable(),
  width: z.number().nonnegative().optional().nullable(),
  height: z.number().nonnegative().optional().nullable(),
  weight: z.number().nonnegative().optional().nullable(),
  isActive: z.boolean().optional(),
});

/** Sums on-hand across warehouses so the list can show one stock number per SKU. */
function summarize(product: { balances: { onHandQty: number; reservedQty: number; incomingQty: number }[] }) {
  const totalOnHand = product.balances.reduce((s, b) => s + b.onHandQty, 0);
  const totalReserved = product.balances.reduce((s, b) => s + b.reservedQty, 0);
  const totalIncoming = product.balances.reduce((s, b) => s + b.incomingQty, 0);
  return {
    totalOnHand,
    totalReserved,
    totalIncoming,
    totalAvailable: totalOnHand - totalReserved,
  };
}

productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const search = String(req.query.search ?? "").trim();
    const activeOnly = req.query.activeOnly === "true";

    const where = {
      ...(activeOnly ? { isActive: true } : {}),
      ...(search
        ? {
            OR: [
              { sku: contains(search) },
              { name: contains(search) },
              { barcode: contains(search) },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { balances: true },
      }),
    ]);

    res.json({
      data: rows.map(({ balances, ...p }) => ({ ...p, ...summarize({ balances }) })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);

productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const product = await prisma.product.findUnique({
      where: { id },
      include: { balances: { include: { warehouse: true } } },
    });
    if (!product) throw notFound("Product not found");
    const { balances, ...rest } = product;
    res.json({
      ...rest,
      ...summarize({ balances }),
      balances: balances.map((b) => ({ ...b, availableQty: b.onHandQty - b.reservedQty })),
    });
  })
);

productsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = parseBody(productSchema, req.body);
    const product = await prisma.product.create({ data });
    res.status(201).json(product);
  })
);

productsRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const data = parseBody(productSchema.partial(), req.body);
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw notFound("Product not found");
    const product = await prisma.product.update({ where: { id }, data });
    res.json(product);
  })
);

/**
 * Hard-deletes when the product has never moved, otherwise soft-deletes so the
 * audit trail stays intact. Pass ?hard=true to force removal.
 */
productsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    // The count and the delete run in one transaction: checking first and
    // deleting afterwards leaves a window where a concurrent order line makes
    // the delete illegal between the two statements.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id } });
      if (!existing) throw notFound("Product not found");

      // A product that has moved, or is referenced by an order, keeps its rows
      // so history stays readable; it is deactivated instead.
      const referenceCounts = await Promise.all([
        tx.inventoryMovement.count({ where: { productId: id } }),
        tx.salesOrderLine.count({ where: { productId: id } }),
        tx.purchaseOrderLine.count({ where: { productId: id } }),
        tx.stockTransfer.count({ where: { productId: id } }),
        tx.stockAdjustment.count({ where: { productId: id } }),
      ]);

      if (referenceCounts.reduce((a, b) => a + b, 0) === 0) {
        await tx.inventoryBalance.deleteMany({ where: { productId: id } });
        await tx.product.delete({ where: { id } });
        return { deleted: true, soft: false };
      }
      await tx.product.update({ where: { id }, data: { isActive: false } });
      return { deleted: true, soft: true };
    });

    res.json(result);
  })
);
