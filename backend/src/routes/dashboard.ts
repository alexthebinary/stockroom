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
    const now = Date.now();
    const days = (d: Date) => Math.floor((now - d.getTime()) / 86_400_000);
    /** "0 days ago" is not something anyone says. */
    const ago = (d: Date) => {
      const n = days(d);
      return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
    };

    const [invoices, bills, shipments, poLines, balances] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { not: "VOID" } },
        select: {
          id: true, invoiceNumber: true, totalCents: true, issueDate: true, dueDate: true,
          customer: { select: { name: true } },
          salesOrder: { select: { id: true } },
          payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } },
        },
      }),
      prisma.bill.findMany({
        where: { status: { not: "VOID" } },
        select: {
          id: true, billNumber: true, totalCents: true, issueDate: true,
          vendor: { select: { name: true } },
          purchaseOrder: { select: { id: true, poNumber: true } },
          payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } },
        },
      }),
      prisma.shipment.findMany({
        where: { deliveredAt: null, status: { not: "VOID" } },
        select: {
          id: true, shipmentNumber: true, shippedAt: true, trackingNumber: true,
          salesOrder: { select: { id: true, customerName: true } },
        },
      }),
      prisma.purchaseOrderLine.findMany({
        where: { purchaseOrder: { status: { in: ["POSTED", "PAID"] } } },
        select: {
          quantity: true, receivedQty: true, purchaseOrderId: true,
          product: { select: { sku: true } },
          purchaseOrder: { select: { poNumber: true, supplierName: true, createdAt: true } },
        },
      }),
      prisma.inventoryBalance.findMany({
        where: { reorderPoint: { gt: 0 } },
        select: {
          onHandQty: true, reservedQty: true, reorderPoint: true, incomingQty: true,
          product: { select: { id: true, sku: true, name: true } },
          warehouse: { select: { code: true } },
        },
      }),
    ]);

    // Generic over both documents: invoices and bills diverged once they
    // started carrying their own party and parent order, and typing this to
    // one of them silently made the other's totals unreachable.
    const owing = <T extends { totalCents: number; issueDate: Date; payments: { amountCents: number }[] }>(
      rows: T[]
    ) =>
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
    // Due by the channel's terms; older invoices without a due date fall back
    // to the common net 30.
    const dueOf = (i: { issueDate: Date; dueDate: Date | null }) =>
      i.dueDate ?? new Date(i.issueDate.getTime() + 30 * 86_400_000);
    const overdue = invoices.filter(
      (i) =>
        i.totalCents - i.payments.reduce((s, p) => s + p.amountCents, 0) > 0 && dueOf(i).getTime() < now
    );

    // A purchase order is short when it has been billed but not fully received.
    const shortOrders = new Set(
      poLines.filter((l) => l.receivedQty < l.quantity).map((l) => l.purchaseOrderId)
    );

    const lowStock = balances.filter(
      (b) => b.onHandQty - b.reservedQty < b.reorderPoint
    ).length;

    /**
     * The same facts as named jobs.
     *
     * A count tells an operator there is a problem; a line tells them which
     * one, how bad, and what to press. Bounded to the few worst of each kind
     * — this is a to-do list, not a report, and a list nobody can finish is
     * one nobody starts.
     */
    type Job = {
      id: string;
      severity: "urgent" | "notice";
      title: string;
      detail: string;
      to: string;
      action?: { label: string; to: string };
      amountCents?: number;
    };
    const jobs: Job[] = [];

    for (const inv of invoices
      .map((i) => ({ ...i, outstanding: i.totalCents - i.payments.reduce((s, p) => s + p.amountCents, 0) }))
      .filter((i) => i.outstanding > 0)
      .sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime())
      .slice(0, 3)) {
      const late = days(dueOf(inv));
      jobs.push({
        id: `inv-${inv.id}`,
        severity: late > 0 ? "urgent" : "notice",
        title: `${inv.invoiceNumber} unpaid${late > 0 ? ` — ${late} days overdue` : ""}`,
        detail: inv.customer?.name ?? "Customer",
        amountCents: inv.outstanding,
        to: inv.salesOrder ? `/sales-orders/${inv.salesOrder.id}` : "/invoices",
        action: inv.salesOrder
          ? { label: "Record payment", to: `/sales-orders/${inv.salesOrder.id}` }
          : undefined,
      });
    }

    const shortByOrder = new Map<number, { poNumber: string; supplier: string; short: number; ordered: number; skus: string[]; createdAt: Date }>();
    for (const l of poLines) {
      if (l.receivedQty >= l.quantity) continue;
      const row = shortByOrder.get(l.purchaseOrderId) ?? {
        poNumber: l.purchaseOrder.poNumber, supplier: l.purchaseOrder.supplierName,
        short: 0, ordered: 0, skus: [], createdAt: l.purchaseOrder.createdAt,
      };
      row.short += l.quantity - l.receivedQty;
      row.ordered += l.quantity;
      if (row.skus.length < 2) row.skus.push(l.product.sku);
      shortByOrder.set(l.purchaseOrderId, row);
    }
    for (const [poId, row] of [...shortByOrder.entries()].slice(0, 3)) {
      jobs.push({
        id: `po-${poId}`,
        severity: "urgent",
        title: `${row.poNumber} short ${row.short} of ${row.ordered}`,
        detail: `${row.supplier} · ${row.skus.join(", ")} · ordered ${ago(row.createdAt)}`,
        to: `/purchase-orders/${poId}`,
        action: { label: "Receive", to: `/purchase-orders/${poId}` },
      });
    }

    for (const b of balances
      .filter((x) => x.onHandQty - x.reservedQty < x.reorderPoint)
      .sort((a, b2) => a.onHandQty - a.reservedQty - (b2.onHandQty - b2.reservedQty))
      .slice(0, 3)) {
      const available = b.onHandQty - b.reservedQty;
      jobs.push({
        id: `stock-${b.product.id}-${b.warehouse.code}`,
        severity: available <= 0 ? "urgent" : "notice",
        title: `${b.product.sku} at ${b.warehouse.code}: ${available} left`,
        detail:
          `Reorder at ${b.reorderPoint}` +
          (b.incomingQty > 0 ? ` · ${b.incomingQty} already incoming` : " · nothing on order"),
        to: `/products/${b.product.id}`,
        action: b.incomingQty > 0 ? undefined : { label: "Order more", to: "/purchase-orders" },
      });
    }

    for (const b of bills
      .map((x) => ({ ...x, outstanding: x.totalCents - x.payments.reduce((s, p) => s + p.amountCents, 0) }))
      .filter((x) => x.outstanding > 0)
      .slice(0, 2)) {
      jobs.push({
        id: `bill-${b.id}`,
        severity: "notice",
        title: `${b.billNumber} to pay`,
        detail: b.vendor?.name ?? "Vendor",
        amountCents: b.outstanding,
        to: b.purchaseOrder ? `/purchase-orders/${b.purchaseOrder.id}` : "/bills",
        action: b.purchaseOrder
          ? { label: "Pay vendor", to: `/purchase-orders/${b.purchaseOrder.id}` }
          : undefined,
      });
    }

    // Only the ones old enough to be worth asking about. Stockroom cannot see
    // a delivery, so a shipment that left yesterday is not yet a problem.
    for (const sh of shipments.filter((x) => days(x.shippedAt) >= 7).slice(0, 2)) {
      jobs.push({
        id: `ship-${sh.id}`,
        severity: "notice",
        title: `${sh.shipmentNumber} left ${ago(sh.shippedAt)}, no delivery confirmed`,
        detail: `${sh.salesOrder?.customerName ?? "Customer"}${sh.trackingNumber ? ` · ${sh.trackingNumber}` : " · no tracking recorded"}`,
        to: sh.salesOrder ? `/sales-orders/${sh.salesOrder.id}` : "/deliveries",
        action: sh.salesOrder
          ? { label: "Confirm delivery", to: `/sales-orders/${sh.salesOrder.id}` }
          : undefined,
      });
    }

    jobs.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "urgent" ? -1 : 1));

    res.json({
      jobs,
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
