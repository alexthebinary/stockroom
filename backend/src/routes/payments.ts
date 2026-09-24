/**
 * Payments, both ways, in one register.
 *
 * Reading only: registering a payment goes through the SAME routes the order
 * pages use (/sales-orders/:id/pay, /purchase-orders/:id/pay), so there is one
 * money path with one set of guards (row locks, overpay checks, status
 * claims) — never a second, lighter one written for a list page.
 */
import { Router } from "express";
import { prisma } from "../db";
import { badRequest } from "../errors";
import { asyncHandler, pagination } from "../http";

export const paymentsRouter = Router();

function directionOf(q: unknown) {
  const d = String(q ?? "").toUpperCase();
  if (d !== "RECEIPT" && d !== "DISBURSEMENT") throw badRequest("direction must be RECEIPT or DISBURSEMENT");
  return d;
}

/** GET /api/payments?direction=RECEIPT|DISBURSEMENT — the register, newest first. */
paymentsRouter.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const direction = directionOf(req.query.direction);
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const where = { direction };
    const [total, rows] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        skip,
        take,
        orderBy: [{ paidAt: "desc" }, { id: "desc" }],
        include: {
          customer: { select: { name: true } },
          vendor: { select: { name: true } },
          invoice: { select: { invoiceNumber: true, salesOrderId: true, salesOrder: { select: { orderNumber: true } } } },
          salesOrder: { select: { id: true, orderNumber: true, customerName: true } },
          bill: { select: { billNumber: true, purchaseOrder: { select: { id: true, poNumber: true, supplierName: true } } } },
        },
      }),
    ]);
    res.json({
      data: rows.map((p) => {
        const orderId = p.salesOrder?.id ?? p.invoice?.salesOrderId ?? null;
        const po = p.bill?.purchaseOrder ?? null;
        return {
          id: p.id,
          paymentNumber: p.paymentNumber,
          paidAt: p.paidAt,
          amountCents: p.amountCents,
          method: p.method,
          status: p.status,
          party: p.customer?.name ?? p.salesOrder?.customerName ?? p.vendor?.name ?? po?.supplierName ?? "—",
          // What the money was against, as the person would name it.
          against:
            direction === "RECEIPT"
              ? p.invoice
                ? `${p.invoice.invoiceNumber}${p.invoice.salesOrder ? ` · ${p.invoice.salesOrder.orderNumber}` : ""}`
                : p.salesOrder
                  ? `${p.salesOrder.orderNumber} · paid at checkout`
                  : "—"
              : p.bill
                ? `${p.bill.billNumber}${po ? ` · ${po.poNumber}` : ""}`
                : "—",
          to: direction === "RECEIPT" ? (orderId ? `/sales-orders/${orderId}` : null) : po ? `/purchase-orders/${po.id}` : null,
        };
      }),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);

/**
 * GET /api/payments/open?direction= — what can be paid right now, with what is
 * left on each. Receipts: an order awaiting checkout payment, or an invoiced
 * one with a balance. Disbursements: a posted bill with a balance.
 */
paymentsRouter.get(
  "/payments/open",
  asyncHandler(async (req, res) => {
    const direction = directionOf(req.query.direction);
    const live = { status: { not: "VOID" } };

    if (direction === "RECEIPT") {
      const orders = await prisma.salesOrder.findMany({
        where: { paymentStatus: { in: ["AWAITING_PAYMENT", "INVOICED"] }, readinessStatus: { not: "CANCELED" } },
        orderBy: { id: "desc" },
        include: {
          invoices: { where: { status: "POSTED" }, include: { payments: { where: live, select: { amountCents: true } } } },
          deposits: { where: { ...live, invoiceId: null }, select: { amountCents: true } },
        },
      });
      const data = orders
        .map((o) => {
          const invoice = o.invoices[0];
          const paid = invoice
            ? invoice.payments.reduce((s, p) => s + p.amountCents, 0)
            : o.deposits.reduce((s, p) => s + p.amountCents, 0);
          const total = invoice ? invoice.totalCents : o.totalCents;
          return {
            kind: invoice ? "invoice" : "checkout",
            id: o.id,
            payPath: `/sales-orders/${o.id}/pay`,
            label: invoice ? `${invoice.invoiceNumber} · ${o.orderNumber}` : `${o.orderNumber} · before shipping`,
            party: o.customerName,
            dueDate: invoice?.dueDate ?? null,
            totalCents: total,
            outstandingCents: total - paid,
          };
        })
        .filter((r) => r.outstandingCents > 0 && r.totalCents > 0);
      return res.json({ data });
    }

    const bills = await prisma.bill.findMany({
      where: { status: "POSTED", purchaseOrder: { is: { status: { in: ["POSTED", "DELIVERED"] } } } },
      orderBy: { id: "desc" },
      include: {
        purchaseOrder: { select: { id: true, poNumber: true, supplierName: true } },
        payments: { where: live, select: { amountCents: true } },
      },
    });
    const data = bills
      .flatMap((b) => (b.purchaseOrder ? [{ ...b, purchaseOrder: b.purchaseOrder }] : []))
      .map((b) => ({
        kind: "bill",
        id: b.purchaseOrder.id,
        payPath: `/purchase-orders/${b.purchaseOrder.id}/pay`,
        label: `${b.billNumber} · ${b.purchaseOrder.poNumber}`,
        party: b.purchaseOrder.supplierName,
        dueDate: null,
        totalCents: b.totalCents,
        outstandingCents: b.totalCents - b.payments.reduce((s, p) => s + p.amountCents, 0),
      }))
      .filter((r) => r.outstandingCents > 0);
    res.json({ data });
  })
);
