import { prisma } from "./db";
import { conflict, badRequest } from "./errors";
import { inventoryValuation, trialBalance } from "./books";
import { getLockDate, setLockDate } from "./period";

/**
 * Month-end close: the thing a business actually buys.
 *
 * Nobody wants inventory software for its own sake. They want to be able to say
 * "September's stock and books are closed, and they are right". So the close is
 * the unit this app delivers, and this file is its rulebook: every check is a
 * plain-English statement of what "correct" means, with the reason it matters
 * and the button that fixes it.
 *
 * Two kinds of check, and the difference is the point:
 *  - BLOCKING — the books are wrong or would be trapped wrong. Closing over one
 *    would lock a mistake into a period nobody can touch afterwards.
 *  - WARNING — the books are right but the business has loose ends (a supplier
 *    shipped short, a customer has not paid). Those are real, but they are next
 *    month's work, so they are carried forward and named in the close record
 *    rather than holding the close hostage.
 *
 * Every check is derived at read time, and the close route re-runs them all
 * server-side immediately before locking — a page that said "ready" five
 * minutes ago proves nothing.
 */

export type Finding = { key: string; title: string; detail?: string; to?: string; amountCents?: number };

export type CloseCheck = {
  id: string;
  title: string;
  why: string;
  blocking: boolean;
  passed: boolean;
  findingCount: number;
  findings: Finding[];
  fix?: { label: string; to: string };
};

export type CloseReport = {
  period: string;
  periodEnd: string;
  status: "open" | "in_progress" | "closed";
  lockDate: string | null;
  canClose: boolean;
  blockingFailed: number;
  warningsFailed: number;
  passed: number;
  total: number;
  checks: CloseCheck[];
  runAt: string;
};

export type CloseRecord = {
  period: string;
  periodEnd: string;
  closedAt: string;
  actor: string;
  passed: number;
  total: number;
  warnings: { id: string; title: string; findingCount: number }[];
};

/** Enough to act on; the count says how many more there are. */
const FINDINGS_SHOWN = 20;
const DAY = 86_400_000;
const RECORD_PREFIX = "close.";

/** "2026-09" -> the last millisecond of 30 September 2026, UTC. */
export function parsePeriod(period: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw badRequest("period must look like YYYY-MM");
  const year = Number(m[1]);
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { period, end, endDay: end.toISOString().slice(0, 10) };
}

function check(
  base: Omit<CloseCheck, "passed" | "findingCount" | "findings">,
  findings: Finding[]
): CloseCheck {
  return {
    ...base,
    passed: findings.length === 0,
    findingCount: findings.length,
    findings: findings.slice(0, FINDINGS_SHOWN),
  };
}

const outstanding = (r: { totalCents: number; payments: { amountCents: number }[] }) =>
  r.totalCents - r.payments.reduce((s, p) => s + p.amountCents, 0);

export async function runCloseChecks(period: string, now = new Date()): Promise<CloseReport> {
  const { end, endDay } = parsePeriod(period);
  const endMs = end.getTime();
  const days = (d: Date) => Math.floor((endMs - d.getTime()) / DAY);

  const [tb, valuation, lock, balances, lots, drafts, counts, poLines, transfers, invoices, bills, shipments, orders] =
    await Promise.all([
      trialBalance(endDay),
      inventoryValuation(),
      getLockDate(),
      prisma.inventoryBalance.findMany({
        select: {
          productId: true, warehouseId: true, onHandQty: true, reservedQty: true,
          product: { select: { sku: true } }, warehouse: { select: { code: true } },
        },
      }),
      prisma.inventoryLot.groupBy({ by: ["productId", "warehouseId"], _sum: { remainingQty: true } }),
      prisma.journalEntry.findMany({
        where: { status: { not: "POSTED" }, hasBeenPosted: false, entryDate: { lte: end } },
        select: { id: true, entryNumber: true, transactionType: true, entryDate: true },
      }),
      prisma.stockCount.findMany({
        where: { status: "DRAFT", countedAt: { lte: end } },
        select: { id: true, countNumber: true, countedAt: true, warehouse: { select: { code: true } } },
      }),
      prisma.purchaseOrderLine.findMany({
        where: { purchaseOrder: { status: { in: ["POSTED", "PAID"] }, createdAt: { lte: end } } },
        select: {
          quantity: true, receivedQty: true, purchaseOrderId: true,
          purchaseOrder: { select: { poNumber: true, supplierName: true } },
        },
      }),
      prisma.stockTransfer.findMany({
        where: { status: "IN_TRANSIT", createdAt: { lte: end } },
        select: {
          id: true, quantity: true, costCents: true, createdAt: true,
          product: { select: { sku: true } },
          fromWarehouse: { select: { code: true } }, toWarehouse: { select: { code: true } },
        },
      }),
      prisma.invoice.findMany({
        where: { status: { not: "VOID" }, issueDate: { lte: end } },
        select: {
          id: true, invoiceNumber: true, totalCents: true, issueDate: true, dueDate: true,
          customer: { select: { name: true } }, salesOrderId: true,
          payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } },
        },
      }),
      prisma.bill.findMany({
        where: { status: { not: "VOID" }, issueDate: { lte: end } },
        select: {
          id: true, billNumber: true, totalCents: true, issueDate: true,
          vendor: { select: { name: true } }, purchaseOrderId: true,
          payments: { where: { status: { not: "VOID" } }, select: { amountCents: true } },
        },
      }),
      prisma.shipment.findMany({
        where: { deliveredAt: null, status: { not: "VOID" }, shippedAt: { lte: new Date(endMs - 7 * DAY) } },
        select: {
          id: true, shipmentNumber: true, shippedAt: true,
          salesOrder: { select: { id: true, customerName: true } },
        },
      }),
      prisma.salesOrder.findMany({
        where: { createdAt: { lte: end }, readinessStatus: { not: "CANCELED" } },
        select: {
          id: true, orderNumber: true, customerName: true, channel: true, totalCents: true,
          readinessStatus: true, paymentStatus: true,
          invoices: { where: { status: { not: "VOID" } }, select: { id: true } },
          deposits: { where: { status: { not: "VOID" }, invoiceId: null }, select: { amountCents: true } },
        },
      }),
    ]);

  const checks: CloseCheck[] = [];

  // ---- BLOCKING -----------------------------------------------------------

  checks.push(
    check(
      {
        id: "ledger-sound",
        title: "Every journal entry balances and nothing has left the books unexplained",
        why: "An unbalanced, orphaned or silently withdrawn entry means the month's figures are wrong, and a lock would freeze them that way.",
        blocking: true,
        fix: { label: "Open the ledger", to: "/ledger" },
      },
      [
        ...tb.unbalancedEntries.map((e) => ({
          key: `unbalanced-${e.id}`,
          title: `${e.entryNumber} does not balance`,
          detail: `Debits ${e.debitCents} vs credits ${e.creditCents} (cents)`,
          to: "/ledger",
        })),
        ...tb.chartInconsistencies.map((a) => ({
          key: `chart-${a.code}`,
          title: `Account ${a.code} ${a.name} is signed the wrong way`,
          detail: `${a.accountType} accounts are ${a.expectedSide}-normal, this one says ${a.normalSide}`,
          to: "/catalogs/posting",
        })),
        ...tb.orphanedReversals.map((r) => ({
          key: `orphan-${r.entryNumber}`,
          title: `${r.entryNumber} reverses an entry that no longer exists`,
          to: "/ledger",
        })),
        ...tb.withdrawnEntries.map((e) => ({
          key: `withdrawn-${e.id}`,
          title: `${e.entryNumber} was posted and is now ${e.status.toLowerCase()}`,
          detail: `${e.transactionType} — its document still claims to be on the books`,
          to: "/ledger",
        })),
      ]
    )
  );

  checks.push(
    check(
      {
        id: "unposted-entries",
        title: "No unposted journal entries are dated in this month",
        why: "Once the month is locked, an entry dated inside it can never be posted. Post it or delete it first.",
        blocking: true,
        fix: { label: "Review entries", to: "/ledger" },
      },
      drafts.map((e) => ({
        key: `draft-${e.id}`,
        title: `${e.entryNumber} is still unposted`,
        detail: `${e.transactionType} dated ${e.entryDate.toISOString().slice(0, 10)}`,
        to: "/ledger",
      }))
    )
  );

  checks.push(
    check(
      {
        id: "stock-value-reconciled",
        title: "Stock value on the shelves equals the Inventory account",
        why: "The cost of every unit you hold must match what the balance sheet says you own. A gap means costing and accounting have drifted.",
        blocking: true,
        fix: { label: "Open valuation", to: "/reports/valuation" },
      },
      valuation.reconciled
        ? []
        : [
            {
              key: "valuation",
              title: "Stock value and the ledger disagree",
              detail: "Cost layers plus goods in transit vs the Inventory account",
              amountCents: valuation.varianceCents,
              to: "/reports/valuation",
            },
          ]
    )
  );

  const layerQty = new Map(lots.map((l) => [`${l.productId}:${l.warehouseId}`, l._sum.remainingQty ?? 0]));
  checks.push(
    check(
      {
        id: "layers-match-on-hand",
        title: "Every unit on hand has a cost behind it",
        why: "FIFO cost of goods sold is only right if the units you count and the units you have costs for are the same units.",
        blocking: true,
        fix: { label: "Open stock on hand", to: "/inventory" },
      },
      balances
        .filter((b) => (layerQty.get(`${b.productId}:${b.warehouseId}`) ?? 0) !== b.onHandQty)
        .map((b) => {
          const costed = layerQty.get(`${b.productId}:${b.warehouseId}`) ?? 0;
          return {
            key: `layers-${b.productId}-${b.warehouseId}`,
            title: `${b.product.sku} at ${b.warehouse.code}: ${b.onHandQty} on hand, ${costed} costed`,
            to: `/products/${b.productId}`,
          };
        })
    )
  );

  checks.push(
    check(
      {
        id: "stock-counts-posted",
        title: "Every stock count started this month is posted or cancelled",
        why: "An open count holds a variance nobody has booked. Closing over it leaves the shelves and the books knowingly different.",
        blocking: true,
        fix: { label: "Open adjustments", to: "/adjustments" },
      },
      counts.map((c) => ({
        key: `count-${c.id}`,
        title: `${c.countNumber} at ${c.warehouse.code} is still open`,
        detail: `Started ${c.countedAt.toISOString().slice(0, 10)}`,
        to: "/adjustments",
      }))
    )
  );

  const shipped = (o: { readinessStatus: string }) =>
    o.readinessStatus === "SHIPPED" || o.readinessStatus === "DELIVERED";
  checks.push(
    check(
      {
        id: "shipped-invoiced",
        title: "Every order that shipped has been invoiced",
        why: "Goods that left without an invoice are sales missing from the month: the cost is booked and the revenue is not.",
        blocking: true,
        fix: { label: "Open sales orders", to: "/sales-orders" },
      },
      orders
        .filter((o) => shipped(o) && o.invoices.length === 0 && o.totalCents > 0)
        .map((o) => ({
          key: `unbilled-${o.id}`,
          title: `${o.orderNumber} shipped with no invoice`,
          detail: `${o.customerName} · ${o.channel}`,
          amountCents: o.totalCents,
          to: `/sales-orders/${o.id}`,
        }))
    )
  );

  // ---- WARNINGS (carried forward) -----------------------------------------

  checks.push(
    check(
      {
        id: "revenue-follows-shipment",
        title: "No order is invoiced before its goods have shipped",
        why: "Billing ahead of shipment books revenue for stock still on your shelf. Fine for a wholesale pro-forma, but it should be deliberate.",
        blocking: false,
        fix: { label: "Open sales orders", to: "/sales-orders" },
      },
      orders
        .filter((o) => !shipped(o) && o.invoices.length > 0)
        .map((o) => ({
          key: `early-${o.id}`,
          title: `${o.orderNumber} invoiced, not shipped`,
          detail: `${o.customerName} · ${o.channel}`,
          amountCents: o.totalCents,
          to: `/sales-orders/${o.id}`,
        }))
    )
  );

  checks.push(
    check(
      {
        id: "deposits-owed",
        title: "No checkout payments are waiting on unshipped orders",
        why: "Money taken at checkout is owed back as goods. These customers have paid and are waiting — ship them or refund them.",
        blocking: false,
        fix: { label: "Open sales orders", to: "/sales-orders" },
      },
      orders
        .filter((o) => o.deposits.length > 0 && !shipped(o))
        .map((o) => ({
          key: `deposit-${o.id}`,
          title: `${o.orderNumber} paid at checkout, not shipped`,
          detail: `${o.customerName} · ${o.channel}`,
          amountCents: o.deposits.reduce((sum, d) => sum + d.amountCents, 0),
          to: `/sales-orders/${o.id}`,
        }))
    )
  );


  const shortByOrder = new Map<number, { poNumber: string; supplier: string; short: number }>();
  for (const l of poLines) {
    if (l.receivedQty >= l.quantity) continue;
    const row = shortByOrder.get(l.purchaseOrderId) ?? {
      poNumber: l.purchaseOrder.poNumber, supplier: l.purchaseOrder.supplierName, short: 0,
    };
    row.short += l.quantity - l.receivedQty;
    shortByOrder.set(l.purchaseOrderId, row);
  }
  checks.push(
    check(
      {
        id: "receipts-complete",
        title: "Everything ordered from suppliers this month has arrived",
        why: "You have paid or owe for goods that are not on the shelf. Chase the supplier or record the short shipment.",
        blocking: false,
        fix: { label: "Receive", to: "/receive" },
      },
      [...shortByOrder.entries()].map(([id, r]) => ({
        key: `short-${id}`,
        title: `${r.poNumber} is ${r.short} unit${r.short === 1 ? "" : "s"} short`,
        detail: r.supplier,
        to: `/purchase-orders/${id}`,
      }))
    )
  );

  checks.push(
    check(
      {
        id: "transfers-arrived",
        title: "No stock is stuck between warehouses",
        why: "Goods in transit belong to neither warehouse. Anything still moving at month end should be received or explained.",
        blocking: false,
        fix: { label: "Open transfers", to: "/transfers" },
      },
      transfers.map((t) => ({
        key: `transfer-${t.id}`,
        title: `${t.quantity} × ${t.product.sku}, ${t.fromWarehouse.code} → ${t.toWarehouse.code}`,
        detail: `In transit ${days(t.createdAt)} days at month end`,
        amountCents: t.costCents,
        to: "/transfers",
      }))
    )
  );

  checks.push(
    check(
      {
        id: "receivables-current",
        title: "No customer invoice is past its due date",
        why: "Late receivables are the first place cash goes missing. Chase them, or write them off deliberately.",
        blocking: false,
        fix: { label: "Open invoices", to: "/invoices" },
      },
      invoices
        // Due by the channel's terms; invoices from before terms existed fall
        // back to the common net 30.
        .filter((i) => outstanding(i) > 0 && (i.dueDate ?? new Date(i.issueDate.getTime() + 30 * DAY)).getTime() < endMs)
        .sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime())
        .map((i) => ({
          key: `invoice-${i.id}`,
          title: `${i.invoiceNumber} — ${days(i.dueDate ?? new Date(i.issueDate.getTime() + 30 * DAY))} days overdue at month end`,
          detail: i.customer.name,
          amountCents: outstanding(i),
          to: i.salesOrderId ? `/sales-orders/${i.salesOrderId}` : "/invoices",
        }))
    )
  );

  checks.push(
    check(
      {
        id: "payables-settled",
        title: "Supplier bills from this month are paid",
        why: "Not an error — just what you owe going into next month, so nobody is surprised by it.",
        blocking: false,
        fix: { label: "Open bills", to: "/bills" },
      },
      bills
        .filter((b) => outstanding(b) > 0)
        .map((b) => ({
          key: `bill-${b.id}`,
          title: `${b.billNumber} unpaid`,
          detail: b.vendor.name,
          amountCents: outstanding(b),
          to: b.purchaseOrderId ? `/purchase-orders/${b.purchaseOrderId}` : "/bills",
        }))
    )
  );

  checks.push(
    check(
      {
        id: "deliveries-confirmed",
        title: "Every shipment older than a week has a confirmed delivery",
        why: "An unconfirmed delivery is revenue you cannot prove the customer received.",
        blocking: false,
        fix: { label: "Open deliveries", to: "/deliveries" },
      },
      shipments.map((s) => ({
        key: `ship-${s.id}`,
        title: `${s.shipmentNumber} shipped ${s.shippedAt.toISOString().slice(0, 10)}`,
        detail: s.salesOrder?.customerName ?? "Customer",
        to: s.salesOrder ? `/sales-orders/${s.salesOrder.id}` : "/deliveries",
      }))
    )
  );

  checks.push(
    check(
      {
        id: "reservations-covered",
        title: "No product is promised to more orders than you hold",
        why: "Reserved above on-hand means an order that cannot ship as packed.",
        blocking: false,
        fix: { label: "Open stock on hand", to: "/inventory" },
      },
      balances
        .filter((b) => b.reservedQty > b.onHandQty)
        .map((b) => ({
          key: `oversold-${b.productId}-${b.warehouseId}`,
          title: `${b.product.sku} at ${b.warehouse.code}: ${b.reservedQty} reserved, ${b.onHandQty} on hand`,
          to: `/products/${b.productId}`,
        }))
    )
  );

  const blockingFailed = checks.filter((c) => c.blocking && !c.passed).length;
  const warningsFailed = checks.filter((c) => !c.blocking && !c.passed).length;
  const status: CloseReport["status"] =
    lock && lock.getTime() >= endMs ? "closed" : now.getTime() <= endMs ? "in_progress" : "open";

  return {
    period,
    periodEnd: end.toISOString(),
    status,
    lockDate: lock ? lock.toISOString() : null,
    canClose: status === "open" && blockingFailed === 0,
    blockingFailed,
    warningsFailed,
    passed: checks.filter((c) => c.passed).length,
    total: checks.length,
    checks,
    runAt: now.toISOString(),
  };
}

/**
 * Close a month: re-prove every blocking check, then move the period lock.
 *
 * The lock is the existing ledger control (period.ts), so a closed month is
 * protected by exactly the same guard as a hand-set lock date — the close adds
 * the proof, not a second mechanism. The record is written to LedgerSetting
 * because it is a small append-only fact about the books, not a new table.
 */
export async function closePeriod(period: string, actor: string, now = new Date()) {
  const report = await runCloseChecks(period, now);
  if (report.status === "closed") throw conflict(`${period} is already closed`);
  if (report.status === "in_progress") {
    throw conflict(`${period} has not ended yet — it can be closed after ${report.periodEnd.slice(0, 10)}`);
  }
  if (report.blockingFailed > 0) {
    const failing = report.checks.filter((c) => c.blocking && !c.passed).map((c) => c.title);
    throw conflict(`${period} cannot close: ${failing.join("; ")}`, { failing });
  }

  const record: CloseRecord = {
    period,
    periodEnd: report.periodEnd,
    closedAt: now.toISOString(),
    actor,
    passed: report.passed,
    total: report.total,
    warnings: report.checks
      .filter((c) => !c.passed)
      .map((c) => ({ id: c.id, title: c.title, findingCount: c.findingCount })),
  };

  await setLockDate(report.periodEnd.slice(0, 10));
  await prisma.ledgerSetting.upsert({
    where: { key: RECORD_PREFIX + period },
    create: { key: RECORD_PREFIX + period, value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  });

  return { record, report: await runCloseChecks(period, now) };
}

export async function closeHistory(): Promise<CloseRecord[]> {
  const rows = await prisma.ledgerSetting.findMany({ where: { key: { startsWith: RECORD_PREFIX } } });
  return rows
    .map((r) => {
      try {
        return JSON.parse(r.value) as CloseRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is CloseRecord => r !== null)
    .sort((a, b) => b.period.localeCompare(a.period));
}
