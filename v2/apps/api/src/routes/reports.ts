import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { checkBooks } from "../books";
import { parse } from "../http";

const DAY = 86_400_000;

export function registerReports(app: FastifyInstance, { db }: Deps) {
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
    const [items, balances, pools, gl] = await Promise.all([
      db.item.findMany({ orderBy: { sku: "asc" } }),
      db.stockBalance.groupBy({ by: ["itemId"], _sum: { onHand: true, held: true } }),
      db.costPool.findMany(),
      db.journalLine.groupBy({ by: ["itemId", "side"], where: { role: "inventoryOnHand" }, _sum: { amountCents: true } }),
    ]);
    const rows = items
      .map((item) => {
        const balance = balances.find((b) => b.itemId === item.id);
        const pool = pools.find((p) => p.itemId === item.id);
        const glCents = gl.filter((g) => g.itemId === item.id).reduce((s, g) => s + (g.side === "DEBIT" ? 1 : -1) * (g._sum.amountCents ?? 0), 0);
        return {
          itemId: item.id,
          sku: item.sku,
          name: item.name,
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
      where: { lifecycle: "OPEN", receivingStatus: { not: "RECEIVED" } },
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
    const bills = await db.vendorBill.findMany({ where: { status: "POSTED" }, orderBy: { dueDate: "asc" } });
    const vendors = await db.vendor.findMany({ where: { id: { in: bills.map((b) => b.vendorId!) } } });
    const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
    const bucketOf = (due: Date) => {
      const late = Math.floor((asOf.getTime() - due.getTime()) / DAY);
      if (late <= 0) return "current";
      if (late <= 30) return "1-30";
      if (late <= 60) return "31-60";
      if (late <= 90) return "61-90";
      return "90+";
    };
    const open = bills.map((b) => ({ ...b, openCents: b.totalCents - b.paidCents - b.creditedCents })).filter((b) => b.openCents !== 0);
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
      db.scanSession.count({ where: { status: "OPEN" } }),
      db.purchaseOrder.count({ where: { lifecycle: "OPEN", receivingStatus: { not: "RECEIVED" } } }),
      db.vendorBill.count({ where: { status: "DRAFT" } }),
      db.scanSession.findMany({ where: { status: "SUBMITTED" }, select: { result: true } }),
      db.vendorBill.findMany({ where: { status: "POSTED" }, select: { totalCents: true, paidCents: true, creditedCents: true, dueDate: true } }),
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
}
