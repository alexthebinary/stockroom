import { Axis, DomainError, State } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { checkBooks } from "../books";
import { inTx, type Tx } from "../db";
import { actorOf, parse } from "../http";
import { createPo } from "../purchasing/po";

const DAY = 86_400_000;

/** The business document behind an on-hand movement, named as on the journal. */
export function movementType(m: { register: string; counterType: string; qtyDelta: number }) {
  if (m.counterType === "OPENING") return "Opening stock";
  if (m.counterType === "RECLASS") return m.qtyDelta < 0 ? "Inventory reclassification – out" : "Inventory reclassification – in";
  if (m.counterType === "VENDOR_CREDIT") return "Purchase return";
  if (m.counterType === "BILL" || m.counterType === "PO") return m.qtyDelta < 0 ? "Receipt reversal" : "Warehouse receipt";
  if (m.register === "WH_OUT") return "Bundle shipped";
  return m.qtyDelta < 0 ? "Inventory adjustment – loss" : "Inventory adjustment – gain";
}

export function registerReports(app: FastifyInstance, { db }: Deps) {
  /** On-hand movements in date/ID order, with each item's balance across warehouses. */
  app.get("/api/reports/inventory-movement", async (request) => {
    const date = z.iso.date().transform((value) => new Date(`${value}T00:00:00.000Z`));
    const { from, to } = parse(z.object({ from: date, to: date }).refine(({ from, to }) => from <= to, {
      path: ["to"], message: "End date must be on or after start date",
    }), request.query);
    const endExclusive = new Date(to.getTime() + DAY);
    // Read opening totals and movements from the same snapshot during stock posting.
    const [opening, movements] = await db.$transaction([
      db.stockMovement.groupBy({ by: ["itemId"], orderBy: { itemId: "asc" }, where: { bucket: "ON_HAND", createdAt: { lt: from } }, _sum: { qtyDelta: true } }),
      db.stockMovement.findMany({ where: { bucket: "ON_HAND", createdAt: { gte: from, lt: endExclusive } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    ], { isolationLevel: "RepeatableRead" });
    const items = await db.item.findMany({ where: { id: { in: [...new Set(movements.map((m) => m.itemId))] } } });
    const byId = new Map(items.map((item) => [item.id, item]));
    // Source documents that have a page: receipts open their order, vendor credits open their bill.
    const docNumbers = [...new Set(movements.map((m) => m.docNumber))];
    const [receipts, credits] = await Promise.all([
      db.warehouseReceipt.findMany({ where: { number: { in: docNumbers } }, select: { number: true, poId: true } }),
      db.vendorCredit.findMany({ where: { number: { in: docNumbers } }, select: { number: true, billId: true } }),
    ]);
    const urls = new Map<string, string>([
      ...receipts.map((r): [string, string] => [r.number, `/orders/${r.poId}`]),
      ...credits.map((c): [string, string] => [c.number, `/bills/${c.billId}`]),
    ]);
    const balances = new Map(opening.map((row) => [row.itemId, row._sum?.qtyDelta ?? 0]));
    const rows = movements.map((movement) => {
      const item = byId.get(movement.itemId);
      const endingBalance = (balances.get(movement.itemId) ?? 0) + movement.qtyDelta;
      balances.set(movement.itemId, endingBalance);
      return {
        id: movement.id,
        itemId: movement.itemId,
        transactionDate: movement.createdAt,
        type: movementType(movement),
        transaction: movement.docNumber,
        transactionUrl: urls.get(movement.docNumber) ?? null,
        sku: item?.sku ?? "",
        name: item?.name ?? "Unknown item",
        brand: item?.brand ?? null,
        category: item?.category ?? null,
        inboundQty: Math.max(movement.qtyDelta, 0),
        outboundQty: Math.max(-movement.qtyDelta, 0),
        endingBalance,
      };
    });
    return { rows };
  });

  /** Every account's debits and credits; header accounts show their children's sum. */
  app.get("/api/reports/trial-balance", async () => {
    const [accounts, sums] = await Promise.all([db.account.findMany({ orderBy: { code: "asc" } }), db.journalLine.groupBy({ by: ["accountId", "side"], _sum: { amountCents: true } })]);
    const own = (id: number, side: string) => sums.find((s) => s.accountId === id && s.side === side)?._sum.amountCents ?? 0;
    const rows = accounts.map((a) => {
      const ids = [a.id, ...accounts.filter((c) => c.parentId === a.id).map((c) => c.id)];
      const debit = ids.reduce((s, id) => s + own(id, "DEBIT"), 0);
      const credit = ids.reduce((s, id) => s + own(id, "CREDIT"), 0);
      const net = debit - credit;
      return { id: a.id, code: a.code, name: a.name, type: a.type, isHeader: a.isHeader, parentId: a.parentId, debitCents: net > 0 ? net : 0, creditCents: net < 0 ? -net : 0 };
    });
    const posting = rows.filter((r) => !r.isHeader);
    return { rows, totalDebitCents: posting.reduce((s, r) => s + r.debitCents, 0), totalCreditCents: posting.reduce((s, r) => s + r.creditCents, 0) };
  });

  /** Stock value item by item, against the ledger's on-hand inventory for that item. */
  app.get("/api/reports/valuation", async () => {
    const [items, balances, pools, gl] = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return Promise.all([
        tx.item.findMany({ orderBy: { sku: "asc" } }),
        tx.stockBalance.groupBy({ by: ["itemId"], _sum: { onHand: true, held: true } }),
        tx.costPool.findMany(),
        tx.journalLine.groupBy({ by: ["itemId", "side"], where: { role: "inventoryOnHand" }, _sum: { amountCents: true } }),
      ]);
    }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
    const rows = items
      .map((item) => {
        const balance = balances.find((b) => b.itemId === item.id);
        const pool = pools.find((p) => p.itemId === item.id);
        const glCents = gl.filter((g) => g.itemId === item.id).reduce((s, g) => s + (g.side === "DEBIT" ? 1 : -1) * (g._sum.amountCents ?? 0), 0);
        return {
          itemId: item.id,
          sku: item.sku,
          name: item.name,
          brand: item.brand,
          category: item.category,
          onHand: balance?._sum.onHand ?? 0,
          held: balance?._sum.held ?? 0,
          valueCents: pool?.valueCents ?? 0,
          averageCents: pool && pool.qty > 0 ? pool.valueCents / pool.qty : 0,
          glCents,
          varianceCents: glCents - (pool?.valueCents ?? 0),
        };
      })
      .filter((r) => r.onHand || r.held || r.valueCents || r.glCents);
    return { rows, totalValueCents: rows.reduce((s, r) => s + r.valueCents, 0), totalGlCents: rows.reduce((s, r) => s + r.glCents, 0) };
  });

  /** Bundles laid out like stock value: what can be made now, its cost at component averages, and the recipe. */
  app.get("/api/reports/bundles", async () => {
    const [bundles, recipe, balances, pools] = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return Promise.all([
        tx.item.findMany({ where: { isBundle: true }, orderBy: { sku: "asc" } }),
        tx.bundleComponent.findMany({ include: { component: true }, orderBy: { id: "asc" } }),
        tx.stockBalance.groupBy({ by: ["itemId"], _sum: { onHand: true } }),
        tx.costPool.findMany(),
      ]);
    }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
    const rows = bundles.map((bundle) => {
      const components = recipe
        .filter((c) => c.bundleId === bundle.id)
        .map((c) => {
          const pool = pools.find((p) => p.itemId === c.componentId);
          return {
            itemId: c.componentId,
            sku: c.component.sku,
            name: c.component.name,
            qtyPerBundle: c.qty,
            onHand: balances.find((b) => b.itemId === c.componentId)?._sum.onHand ?? 0,
            averageCents: pool && pool.qty > 0 ? pool.valueCents / pool.qty : 0,
          };
        });
      const onHand = components.length ? Math.min(...components.map((c) => Math.floor(c.onHand / c.qtyPerBundle))) : 0;
      const averageCents = components.reduce((s, c) => s + c.averageCents * c.qtyPerBundle, 0);
      return { itemId: bundle.id, sku: bundle.sku, name: bundle.name, onHand, averageCents, valueCents: Math.round(onHand * averageCents), components };
    });
    return { rows };
  });

  /** Units at the dock waiting for a bill, oldest first: the queue accounting works down. */
  app.get("/api/reports/held", async () => {
    const lines = await db.purchaseOrderLine.findMany({ where: { qtyHeld: { gt: 0 } }, include: { po: true } });
    const [items, vendors, receipts] = await Promise.all([
      db.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } }),
      db.vendor.findMany({ where: { id: { in: lines.map((l) => l.po.vendorId!).filter(Boolean) } } }),
      db.receiptLine.findMany({ where: { poLineId: { in: lines.map((l) => l.id) } }, include: { receipt: true } }),
    ]);
    const now = Date.now();
    return lines
      .map((l) => {
        const oldest = receipts.filter((r) => r.poLineId === l.id && r.landedQty < r.qty).map((r) => r.receipt.receivedAt.getTime()).sort()[0] ?? now;
        return {
          poId: l.poId,
          poNumber: l.po.number,
          vendor: vendors.find((v) => v.id === l.po.vendorId) ?? null,
          item: items.find((i) => i.id === l.itemId),
          qtyHeld: l.qtyHeld,
          estimateCents: l.qtyHeld * l.unitCostCents,
          receivedAt: new Date(oldest),
          days: Math.floor((now - oldest) / DAY),
        };
      })
      .sort((a, b) => b.days - a.days);
  });

  /**
   * Inventory still to receive: units on open orders that have not arrived at
   * the dock, oldest order first. Billed-but-not-received is the part already
   * owed to the vendor (it sits in inventory in transit).
   */
  app.get("/api/reports/to-receive", async () => {
    const orders = await db.purchaseOrder.findMany({
      where: { lifecycle: State.poLifecycle.OPEN, receivingStatus: { not: Axis.receiving.RECEIVED } },
      include: { lines: true },
      orderBy: { id: "asc" },
    });
    const [items, vendors, warehouses] = await Promise.all([
      db.item.findMany({ where: { id: { in: orders.flatMap((o) => o.lines.map((l) => l.itemId)) } } }),
      db.vendor.findMany({ where: { id: { in: orders.map((o) => o.vendorId!).filter(Boolean) } } }),
      db.warehouse.findMany({ where: { id: { in: orders.map((o) => o.warehouseId) } } }),
    ]);
    const now = Date.now();
    const rows = orders
      .map((o) => {
        const lines = o.lines
          .filter((l) => l.qtyOrdered > l.qtyReceived)
          .map((l) => {
            const outstanding = l.qtyOrdered - l.qtyReceived;
            return {
              lineId: l.id,
              item: items.find((i) => i.id === l.itemId)!,
              ordered: l.qtyOrdered,
              received: l.qtyReceived,
              outstanding,
              billed: l.qtyBilled > l.qtyReceived,
              valueCents: outstanding * l.unitCostCents,
            };
          });
        return {
          poId: o.id,
          poNumber: o.number,
          billingStatus: o.billingStatus,
          vendor: vendors.find((v) => v.id === o.vendorId) ?? null,
          warehouse: warehouses.find((w) => w.id === o.warehouseId) ?? null,
          orderedAt: o.createdAt,
          days: Math.floor((now - o.createdAt.getTime()) / DAY),
          lines,
          units: lines.reduce((s, l) => s + l.outstanding, 0),
          valueCents: lines.reduce((s, l) => s + l.valueCents, 0),
        };
      })
      .filter((o) => o.lines.length > 0);
    return { orders: rows, totalUnits: rows.reduce((s, o) => s + o.units, 0), totalValueCents: rows.reduce((s, o) => s + o.valueCents, 0) };
  });

  /** What we owe, by vendor, aged by days past the due date. */
  app.get("/api/reports/ap-aging", async (request) => {
    const { asOf } = parse(z.object({ asOf: z.coerce.date().default(() => new Date()) }), request.query);
    // Use effective journal dates, including reversals, rather than today's
    // mutable status and paid/credited totals. Each payment/credit identifies
    // its bill, so no allocation policy is needed.
    const { bills, vendors, outstanding } = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const bills = await tx.vendorBill.findMany({ where: { billDate: { lte: asOf } }, orderBy: { dueDate: "asc" } });
      const billIds = bills.map((b) => b.id);
      const [vendors, payments, credits] = await Promise.all([
        tx.vendor.findMany({ where: { id: { in: bills.flatMap((b) => b.vendorId == null ? [] : [b.vendorId]) } } }),
        tx.payment.findMany({ where: { billId: { in: billIds } }, select: { id: true, billId: true } }),
        tx.vendorCredit.findMany({ where: { billId: { in: billIds } }, select: { id: true, billId: true } }),
      ]);
      const paymentBills = new Map(payments.map((p) => [p.id, p.billId]));
      const creditBills = new Map(credits.map((c) => [c.id, c.billId]));
      const lines = await tx.journalLine.findMany({ where: { role: "payable", entry: {
        date: { lte: asOf },
        OR: [
          { sourceType: { in: ["BILL", "BILL_VOID"] }, sourceId: { in: billIds } },
          { sourceType: "PAYMENT", sourceId: { in: payments.map((p) => p.id) } },
          { sourceType: "VENDOR_CREDIT", sourceId: { in: credits.map((c) => c.id) } },
        ],
      } }, include: { entry: { select: { sourceType: true, sourceId: true } } } });
      const outstanding = new Map<number, number>();
      for (const line of lines) {
        const { sourceType, sourceId } = line.entry;
        const billId = sourceType === "PAYMENT" ? paymentBills.get(sourceId)
          : sourceType === "VENDOR_CREDIT" ? creditBills.get(sourceId) : sourceId;
        if (billId != null) outstanding.set(billId, (outstanding.get(billId) ?? 0) + (line.side === "CREDIT" ? line.amountCents : -line.amountCents));
      }
      return { bills, vendors, outstanding };
    }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
    const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
    const bucketOf = (due: Date) => {
      const late = Math.floor((asOf.getTime() - due.getTime()) / DAY);
      if (late <= 0) return "current";
      if (late <= 30) return "1-30";
      if (late <= 60) return "31-60";
      if (late <= 90) return "61-90";
      return "90+";
    };
    const open = bills.map((b) => ({ ...b, openCents: outstanding.get(b.id) ?? 0 })).filter((b) => b.openCents !== 0);
    const byVendor = vendors.map((v) => {
      const mine = open.filter((b) => b.vendorId === v.id);
      const row = Object.fromEntries(buckets.map((k) => [k, mine.filter((b) => bucketOf(b.dueDate) === k).reduce((s, b) => s + b.openCents, 0)]));
      return { vendor: v, ...row, totalCents: mine.reduce((s, b) => s + b.openCents, 0), bills: mine.map((b) => ({ id: b.id, number: b.number, vendorInvoiceNumber: b.vendorInvoiceNumber, dueDate: b.dueDate, openCents: b.openCents, bucket: bucketOf(b.dueDate) })) };
    });
    return { asOf, buckets, vendors: byVendor.filter((v) => v.totalCents !== 0) };
  });

  /** The numbers each home screen opens on. */
  app.get("/api/home", async () => {
    const [openDeliveries, expected, draftBills, unknownSessions, posted, books] = await Promise.all([
      db.scanSession.count({ where: { status: State.scanSession.OPEN } }),
      db.purchaseOrder.count({ where: { lifecycle: State.poLifecycle.OPEN, receivingStatus: { not: Axis.receiving.RECEIVED } } }),
      db.vendorBill.count({ where: { status: State.bill.DRAFT } }),
      db.scanSession.findMany({ where: { status: State.scanSession.SUBMITTED }, select: { result: true } }),
      db.vendorBill.findMany({ where: { status: State.bill.POSTED }, select: { totalCents: true, paidCents: true, creditedCents: true, dueDate: true } }),
      checkBooks(db),
    ]);
    const held = await db.purchaseOrderLine.aggregate({ _sum: { qtyHeld: true } });
    const weekAhead = Date.now() + 7 * DAY;
    const open = posted.map((b) => ({ open: b.totalCents - b.paidCents - b.creditedCents, due: b.dueDate.getTime() })).filter((b) => b.open > 0);
    const unknownItems = unknownSessions.reduce((s, x) => s + ((x.result as { unknown?: unknown[] } | null)?.unknown?.length ?? 0), 0);
    return {
      clerk: { openDeliveries, expectedOrders: expected },
      accounting: {
        draftBills,
        heldUnits: held._sum.qtyHeld ?? 0,
        unknownItems,
        payableCents: open.reduce((s, b) => s + b.open, 0),
        dueThisWeekCents: open.filter((b) => b.due <= weekAhead).reduce((s, b) => s + b.open, 0),
        overdueCents: open.filter((b) => b.due < Date.now()).reduce((s, b) => s + b.open, 0),
      },
      admin: { booksSound: books.sound, problems: books.problems.slice(0, 5) },
    };
  });

  /**
   * Items at or under their reorder minimum. Position is on hand plus units
   * still to receive on open orders. Bundles and serial-tracked items are left out.
   */
  app.get("/api/reports/reorder", async () => {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadReorderRows(tx);
    }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
    return { rows };
  });

  /** One unbilled purchase order per default vendor, through the normal order path. */
  app.post("/api/reports/reorder", async (request) => {
    const body = parse(z.object({
      itemIds: z.array(z.number().int().positive()).min(1),
      warehouseId: z.number().int().positive(),
    }), request.body);
    return inTx(db, async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: body.warehouseId, isActive: true } });
      if (!warehouse) throw new DomainError("Choose a warehouse", 400);
      const rows = await loadReorderRows(tx, [...new Set(body.itemIds)]);
      const skipped = rows.filter((row) => row.vendor == null || row.suggestedQty < 1);
      const byVendor = new Map<number, typeof rows>();
      for (const row of rows) {
        if (row.vendor == null || row.suggestedQty < 1) continue;
        const lines = byVendor.get(row.vendor.id) ?? [];
        lines.push(row);
        byVendor.set(row.vendor.id, lines);
      }
      const orders: { id: number; number: string; vendorId: number; vendorName: string }[] = [];
      for (const [vendorId, lines] of [...byVendor.entries()].sort((a, b) => a[0] - b[0])) {
        const po = await createPo(tx, {
          vendorId,
          warehouseId: warehouse.id,
          source: "MANUAL",
          actor: actorOf(request),
          lines: lines.map((line) => ({ itemId: line.item.id, qtyOrdered: line.suggestedQty, unitCostCents: line.item.lastCostCents })),
        });
        await audit(tx, actorOf(request), "po.created", "PurchaseOrder", po.id);
        orders.push({ id: po.id, number: po.number, vendorId, vendorName: lines[0]!.vendor!.name });
      }
      return {
        orders,
        skipped: skipped.map((row) => ({
          itemId: row.item.id,
          name: row.item.name,
          sku: row.item.sku,
          reason: row.vendor == null ? "no vendor" : "nothing to order",
        })),
      };
    });
  });
}

type ReorderRow = {
  item: { id: number; sku: string; name: string; lastCostCents: number };
  onHand: number;
  onOrder: number;
  reorderPoint: number;
  reorderQty: number | null;
  suggestedQty: number;
  vendor: { id: number; name: string } | null;
};

/** suggestedQty is the reorder quantity, raised to the shortfall when that is larger. */
async function loadReorderRows(tx: Tx, itemIds?: number[]): Promise<ReorderRow[]> {
  const items = await tx.item.findMany({
    where: {
      isActive: true,
      isBundle: false,
      trackingMode: { not: "SERIAL" },
      reorderPoint: { not: null },
      ...(itemIds ? { id: { in: itemIds } } : {}),
    },
    orderBy: { sku: "asc" },
  });
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id);
  const [balances, lines, vendors] = await Promise.all([
    tx.stockBalance.groupBy({ by: ["itemId"], where: { itemId: { in: ids } }, _sum: { onHand: true } }),
    tx.purchaseOrderLine.findMany({
      where: { itemId: { in: ids }, po: { lifecycle: State.poLifecycle.OPEN } },
      select: { itemId: true, qtyOrdered: true, qtyReceived: true },
    }),
    tx.vendor.findMany({
      where: { id: { in: items.flatMap((item) => item.defaultVendorId == null ? [] : [item.defaultVendorId]) } },
      select: { id: true, name: true },
    }),
  ]);
  const onHand = new Map(balances.map((balance) => [balance.itemId, balance._sum.onHand ?? 0]));
  const onOrder = new Map<number, number>();
  for (const line of lines) {
    const outstanding = line.qtyOrdered - line.qtyReceived;
    if (outstanding > 0) onOrder.set(line.itemId, (onOrder.get(line.itemId) ?? 0) + outstanding);
  }
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const rows: ReorderRow[] = [];
  for (const item of items) {
    if (item.reorderPoint == null) continue;
    const hand = onHand.get(item.id) ?? 0;
    const ordered = onOrder.get(item.id) ?? 0;
    if (hand + ordered > item.reorderPoint) continue;
    const shortfall = item.reorderPoint - hand - ordered;
    rows.push({
      item: { id: item.id, sku: item.sku, name: item.name, lastCostCents: item.lastCostCents },
      onHand: hand,
      onOrder: ordered,
      reorderPoint: item.reorderPoint,
      reorderQty: item.reorderQty,
      suggestedQty: Math.max(item.reorderQty ?? 0, shortfall),
      vendor: item.defaultVendorId == null ? null : vendorById.get(item.defaultVendorId) ?? null,
    });
  }
  return rows;
}
