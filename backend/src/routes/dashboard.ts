import { Router } from "express";
import { prisma } from "../db";
import { contains } from "../search";
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

/**
 * What needs doing, right now.
 *
 * The rest of this app answers "what is the state of X". This answers "what
 * should I do next", which is the question an operator actually arrives with.
 * The navigation and the dashboard both read it, so the counts in the sidebar
 * and the work on the page can never disagree.
 *
 * Every figure is DERIVED at read time. None of it is stored, because a cached
 * count of work outstanding is the thing most certain to go stale and most
 * embarrassing when it does — a badge saying "3 to chase" over an empty list
 * is worse than no badge.
 */
dashboardRouter.get(
  "/attention",
  asyncHandler(async (_req, res) => {
    const [invoices, bills, shipments, poLines, balances] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { not: "VOID" } },
        select: { id: true, totalCents: true, issueDate: true, payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } } },
      }),
      prisma.bill.findMany({
        where: { status: { not: "VOID" } },
        select: { id: true, totalCents: true, issueDate: true, payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } } },
      }),
      prisma.shipment.findMany({
        where: { deliveredAt: null, status: { not: "VOID" } },
        select: { id: true, shippedAt: true },
      }),
      prisma.purchaseOrderLine.findMany({
        where: { purchaseOrder: { status: { in: ["POSTED", "PAID"] } } },
        select: { quantity: true, receivedQty: true, purchaseOrderId: true },
      }),
      prisma.inventoryBalance.findMany({
        where: { reorderPoint: { gt: 0 } },
        select: { onHandQty: true, reservedQty: true, reorderPoint: true },
      }),
    ]);

    const owing = (rows: typeof invoices) =>
      rows
        .map((r) => ({
          outstanding: r.totalCents - r.payments.reduce((s, p) => s + p.amountCents, 0),
          issueDate: r.issueDate,
        }))
        .filter((r) => r.outstanding > 0);

    const owedToUs = owing(invoices);
    const owedByUs = owing(bills);

    // "Old" is a judgement, so it is stated rather than hidden: 30 days is the
    // common net term, and anything past it is the thing worth chasing first.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const overdue = owedToUs.filter((i) => i.issueDate < thirtyDaysAgo);

    // A purchase order is short when it has been billed but not fully received.
    const shortOrders = new Set(
      poLines.filter((l) => l.receivedQty < l.quantity).map((l) => l.purchaseOrderId)
    );

    const lowStock = balances.filter(
      (b) => b.onHandQty - b.reservedQty < b.reorderPoint
    ).length;

    res.json({
      invoices: {
        unpaid: owedToUs.length,
        overdue: overdue.length,
        outstandingCents: owedToUs.reduce((s, i) => s + i.outstanding, 0),
      },
      bills: {
        unpaid: owedByUs.length,
        outstandingCents: owedByUs.reduce((s, b) => s + b.outstanding, 0),
      },
      deliveries: { inTransit: shipments.length },
      receipts: { ordersShort: shortOrders.size },
      stock: { belowReorderPoint: lowStock },
      // Ledger soundness is deliberately NOT here. It is computed inline by
      // GET /trial-balance, and copying that computation would put a second
      // source of truth behind a badge — the UI already reads the real one.
    });
  })
);

/**
 * One search across every noun an operator holds in their hand.
 *
 * A warehouse is navigated by identifier — a SKU on a box, a PO on a delivery
 * note, a serial on a unit, an invoice number on a customer's email. Finding
 * one previously meant choosing the right page first and then searching
 * within it, which is five interactions to reach a record whose number you
 * already know.
 *
 * Deliberately capped and shallow: this feeds a palette that must feel
 * instant, not a report. Anything that wants depth has a page of its own.
 */
dashboardRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ results: [] });

    const take = 5;
    const [products, serials, salesOrders, purchaseOrders, invoices, bills, customers, vendors] =
      await Promise.all([
        prisma.product.findMany({
          where: { OR: [{ sku: contains(q) }, { name: contains(q) }] },
          take,
          select: { id: true, sku: true, name: true },
        }),
        prisma.serialUnit.findMany({
          where: { serialNumber: contains(q) },
          take,
          select: { id: true, serialNumber: true, status: true, productId: true },
        }),
        prisma.salesOrder.findMany({
          where: { OR: [{ orderNumber: contains(q) }, { customerName: contains(q) }] },
          take,
          select: { id: true, orderNumber: true, customerName: true, totalCents: true },
        }),
        prisma.purchaseOrder.findMany({
          where: { OR: [{ poNumber: contains(q) }, { supplierName: contains(q) }] },
          take,
          select: { id: true, poNumber: true, supplierName: true, totalCents: true },
        }),
        prisma.invoice.findMany({
          where: { invoiceNumber: contains(q) },
          take,
          select: { id: true, invoiceNumber: true, totalCents: true, salesOrderId: true },
        }),
        prisma.bill.findMany({
          where: { billNumber: contains(q) },
          take,
          select: { id: true, billNumber: true, totalCents: true, purchaseOrderId: true },
        }),
        prisma.customer.findMany({
          where: { name: contains(q) },
          take,
          select: { id: true, name: true },
        }),
        prisma.vendor.findMany({
          where: { name: contains(q) },
          take,
          select: { id: true, name: true },
        }),
      ]);

    const results = [
      ...products.map((p) => ({
        kind: "Product", label: p.sku, detail: p.name, to: `/products/${p.id}`,
      })),
      ...serials.map((s) => ({
        kind: "Serial", label: s.serialNumber,
        detail: String(s.status).toLowerCase().replace(/_/g, " "),
        to: `/products/${s.productId}`,
      })),
      ...salesOrders.map((o) => ({
        kind: "Sales order", label: o.orderNumber, detail: o.customerName,
        to: `/sales-orders/${o.id}`, amountCents: o.totalCents,
      })),
      ...purchaseOrders.map((o) => ({
        kind: "Purchase order", label: o.poNumber, detail: o.supplierName,
        to: `/purchase-orders/${o.id}`, amountCents: o.totalCents,
      })),
      ...invoices.map((i) => ({
        kind: "Invoice", label: i.invoiceNumber, detail: "",
        to: i.salesOrderId ? `/sales-orders/${i.salesOrderId}` : "/invoices",
        amountCents: i.totalCents,
      })),
      ...bills.map((b) => ({
        kind: "Bill", label: b.billNumber, detail: "",
        to: b.purchaseOrderId ? `/purchase-orders/${b.purchaseOrderId}` : "/bills",
        amountCents: b.totalCents,
      })),
      ...customers.map((c) => ({
        kind: "Customer", label: c.name, detail: "", to: "/catalogs/customers",
      })),
      ...vendors.map((v) => ({
        kind: "Vendor", label: v.name, detail: "", to: "/catalogs/vendors",
      })),
    ];

    res.json({ results });
  })
);
