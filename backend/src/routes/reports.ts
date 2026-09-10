import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler, optionalInt } from "../http";
import { ACCOUNT } from "../accounts";

export const reportsRouter = Router();

/** Inclusive date window from ?from=&to=, both optional. */
function window(query: Record<string, unknown>) {
  const from = String(query.from ?? "").trim();
  const to = String(query.to ?? "").trim();
  return {
    from: from ? new Date(from) : null,
    to: to ? new Date(`${to}T23:59:59.999Z`) : null,
    clause: from || to
      ? {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
        }
      : undefined,
  };
}

/** Sums a set of numbers into a group bucket keyed by a label. */
function groupSum<T>(rows: T[], key: (row: T) => string, value: (row: T) => number) {
  const map = new Map<string, { label: string; totalCents: number; count: number }>();
  for (const row of rows) {
    const label = key(row);
    const entry = map.get(label) ?? { label, totalCents: 0, count: 0 };
    entry.totalCents += value(row);
    entry.count += 1;
    map.set(label, entry);
  }
  return [...map.values()].sort((a, b) => b.totalCents - a.totalCents);
}

/**
 * GET /api/reports/sales?from=&to=&groupBy=employee|customer|category|channel
 * Revenue is taken from shipped/invoiced orders, and COGS from the FIFO cost
 * actually consumed — so the margin here is real, not estimated.
 */
reportsRouter.get(
  "/sales",
  asyncHandler(async (req, res) => {
    const { clause } = window(req.query as Record<string, unknown>);
    const groupBy = String(req.query.groupBy ?? "customer");

    const orders = await prisma.salesOrder.findMany({
      where: {
        ...(clause ? { createdAt: clause } : {}),
        paymentStatus: { in: ["INVOICED", "PAID"] },
      },
      include: {
        lines: { include: { product: { include: { productCategory: true } } } },
        customer: true,
        employee: true,
        shipments: true,
      },
    });

    const cogsCents = orders.reduce(
      (sum, o) => sum + o.shipments.reduce((s, sh) => s + sh.cogsCents, 0),
      0
    );
    // Category groups are summed from line values, so the headline revenue is
    // the goods value too — otherwise the groups would not add up to it.
    const revenueCents = orders.reduce((s, o) => s + o.subtotalCents, 0);
    const taxAndShippingCents = orders.reduce((s, o) => s + o.taxCents + o.shippingCents, 0);

    let groups: { label: string; totalCents: number; count: number }[];
    switch (groupBy) {
      case "employee":
        groups = groupSum(orders, (o) => o.employee?.name ?? "Unassigned", (o) => o.subtotalCents);
        break;
      case "channel":
        groups = groupSum(orders, (o) => o.channel, (o) => o.subtotalCents);
        break;
      case "category": {
        // Category groups by line, not by order, since one order can span many.
        const lines = orders.flatMap((o) => o.lines);
        groups = groupSum(
          lines,
          (l) => l.product.productCategory?.name ?? l.product.category ?? "Uncategorised",
          (l) => l.lineTotalCents
        );
        break;
      }
      default:
        groups = groupSum(orders, (o) => o.customerName, (o) => o.subtotalCents);
    }

    res.json({
      groupBy,
      orderCount: orders.length,
      revenueCents,
      taxAndShippingCents,
      cogsCents,
      grossProfitCents: revenueCents - cogsCents,
      groups,
    });
  })
);

/** GET /api/reports/purchases?from=&to=&groupBy=vendor|category */
reportsRouter.get(
  "/purchases",
  asyncHandler(async (req, res) => {
    const { clause } = window(req.query as Record<string, unknown>);
    const groupBy = String(req.query.groupBy ?? "vendor");

    const orders = await prisma.purchaseOrder.findMany({
      where: {
        ...(clause ? { createdAt: clause } : {}),
        status: { in: ["POSTED", "PAID", "DELIVERED"] },
      },
      include: {
        lines: { include: { product: { include: { productCategory: true } } } },
        vendor: true,
      },
    });

    const groups =
      groupBy === "category"
        ? groupSum(
            orders.flatMap((o) => o.lines),
            (l) => l.product.productCategory?.name ?? l.product.category ?? "Uncategorised",
            (l) => l.lineTotalCents
          )
        : groupSum(orders, (o) => o.supplierName, (o) => o.totalCents);

    res.json({
      groupBy,
      orderCount: orders.length,
      spendCents: orders.reduce((s, o) => s + o.totalCents, 0),
      groups,
    });
  })
);

/**
 * GET /api/reports/stock-on-hand?asOf=YYYY-MM-DD&warehouseId=
 *
 * "Stock on a selected date" from the scope. Replays the immutable movement
 * ledger up to that date rather than reading current balances, which is the
 * only way to answer it correctly after the fact.
 */
reportsRouter.get(
  "/stock-on-hand",
  asyncHandler(async (req, res) => {
    const asOf = String(req.query.asOf ?? "").trim();
    const warehouseId = optionalInt(req.query.warehouseId);
    const cutoff = asOf ? new Date(`${asOf}T23:59:59.999Z`) : new Date();

    const movements = await prisma.inventoryMovement.findMany({
      where: {
        createdAt: { lte: cutoff },
        ...(warehouseId
          ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] }
          : {}),
      },
      include: { product: true, fromWarehouse: true, toWarehouse: true },
      orderBy: { createdAt: "asc" },
    });

    // key is `${productId}:${warehouseId}`
    const positions = new Map<
      string,
      {
        productId: number;
        warehouseId: number;
        sku: string;
        productName: string;
        warehouseCode: string;
        quantity: number;
        costCents: number;
      }
    >();

    const touch = (
      productId: number,
      whId: number,
      sku: string,
      productName: string,
      whCode: string
    ) => {
      const key = `${productId}:${whId}`;
      const row =
        positions.get(key) ??
        {
          productId,
          warehouseId: whId,
          sku,
          productName,
          warehouseCode: whCode,
          quantity: 0,
          costCents: 0,
        };
      positions.set(key, row);
      return row;
    };

    /**
     * Each movement is applied to ONE warehouse: the one it actually affected.
     *
     * A movement may name both warehouses for context (a transfer says where
     * it is headed), so applying both sides would count a transfer twice —
     * once when it leaves and again when it lands. The movement type is the
     * authority on direction, not the presence of a field.
     */
    for (const m of movements) {
      const inbound = m.movementType.endsWith("_IN") || m.movementType === "PURCHASE_RECEIPT";
      if (inbound) {
        if (!m.toWarehouseId || !m.toWarehouse) continue;
        const row = touch(m.productId, m.toWarehouseId, m.product.sku, m.product.name, m.toWarehouse.code);
        row.quantity += m.quantity;
        row.costCents += m.totalCostCents;
      } else {
        if (!m.fromWarehouseId || !m.fromWarehouse) continue;
        const row = touch(m.productId, m.fromWarehouseId, m.product.sku, m.product.name, m.fromWarehouse.code);
        row.quantity -= m.quantity;
        row.costCents -= m.totalCostCents;
      }
    }

    const rows = [...positions.values()]
      // The movement query matches a transfer's OTHER warehouse too, so the
      // filter has to be reapplied to the resulting positions.
      .filter((r) => !warehouseId || r.warehouseId === warehouseId)
      .filter((r) => r.quantity !== 0)
      .sort((a, b) => a.sku.localeCompare(b.sku) || a.warehouseCode.localeCompare(b.warehouseCode));

    res.json({
      asOf: asOf || new Date().toISOString().slice(0, 10),
      movementsReplayed: movements.length,
      rows,
      totalQuantity: rows.reduce((s, r) => s + r.quantity, 0),
      totalCostCents: rows.reduce((s, r) => s + r.costCents, 0),
    });
  })
);

/**
 * GET /api/reports/inventory-valuation
 * Current stock value from the open FIFO layers, reconciled against the
 * Inventory account in the ledger. A gap means costing and accounting have
 * drifted, which is exactly what you want a report to tell you.
 */
reportsRouter.get(
  "/inventory-valuation",
  asyncHandler(async (_req, res) => {
    const lots = await prisma.inventoryLot.findMany({
      where: { remainingQty: { gt: 0 } },
      include: { product: true, warehouse: true },
    });

    const byProduct = new Map<
      string,
      { sku: string; name: string; warehouseCode: string; quantity: number; valueCents: number; layers: number }
    >();

    for (const lot of lots) {
      const key = `${lot.productId}:${lot.warehouseId}`;
      const row =
        byProduct.get(key) ??
        {
          sku: lot.product.sku,
          name: lot.product.name,
          warehouseCode: lot.warehouse.code,
          quantity: 0,
          valueCents: 0,
          layers: 0,
        };
      row.quantity += lot.remainingQty;
      row.valueCents += lot.remainingQty * lot.unitCostCents;
      row.layers += 1;
      byProduct.set(key, row);
    }

    const rows = [...byProduct.values()].sort((a, b) => b.valueCents - a.valueCents);
    const layerValueCents = rows.reduce((s, r) => s + r.valueCents, 0);

    const inventoryAccount = await prisma.account.findUnique({ where: { code: ACCOUNT.INVENTORY } });
    let ledgerValueCents = 0;
    if (inventoryAccount) {
      const lines = await prisma.journalLine.findMany({
        where: { accountId: inventoryAccount.id, journalEntry: { status: "POSTED" } },
      });
      ledgerValueCents = lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    }

    // Stock in transit has left its source layers but not yet arrived at the
    // destination, so it is owned by neither warehouse while still being an
    // asset on the books. Counting it is the difference between a real
    // reconciliation and one that cries wolf during every transfer.
    const inTransit = await prisma.stockTransfer.findMany({
      where: { status: "IN_TRANSIT" },
      select: { costCents: true },
    });
    const inTransitCents = inTransit.reduce((s, t) => s + t.costCents, 0);
    const assetValueCents = layerValueCents + inTransitCents;

    res.json({
      rows,
      layerValueCents,
      inTransitCents,
      assetValueCents,
      ledgerValueCents,
      varianceCents: assetValueCents - ledgerValueCents,
      reconciled: assetValueCents === ledgerValueCents,
    });
  })
);
