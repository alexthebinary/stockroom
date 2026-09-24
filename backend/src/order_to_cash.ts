import type { Tx } from "./inventory";
import { badRequest, conflict } from "./errors";
import { postSimple } from "./ledger";
import { ACCOUNT, TRANSACTION_TYPE } from "./accounts";
import { channelPolicy, dueDateFor } from "./channels";
import { lockDocumentForPayment, paidAgainst } from "./payments";
import { nextInvoiceNumber, nextPaymentNumber } from "./numbering";

/**
 * Order to cash for a brand that sells through more than one channel.
 *
 * Two money paths meet at shipment:
 *
 *   PREPAID (Shopify, Amazon, retail)   TERMS (wholesale, direct)
 *   checkout: Dr Bank / Cr Deposits     —
 *   ship:     Dr AR / Cr Revenue        ship: Dr AR / Cr Revenue
 *             Dr Deposits / Cr AR       later: Dr Bank / Cr AR
 *
 * Revenue is booked once, when the goods leave — the same moment COGS is — so
 * a month's margin is matched. Checkout cash is a liability until then: the
 * customer is owed either the goods or their money back.
 */

type OrderForCash = {
  id: number;
  orderNumber: string;
  channel: string;
  customerId: number | null;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  paymentStatus: string;
  readinessStatus: string;
};

/** Live checkout payments on the order not yet applied to an invoice. */
export async function unappliedDeposits(tx: Tx, salesOrderId: number) {
  return tx.payment.findMany({
    where: { salesOrderId, invoiceId: null, status: { not: "VOID" } },
    orderBy: { id: "asc" },
  });
}

/** Take money at checkout, before anything has shipped. */
export async function takeDeposit(
  tx: Tx,
  order: OrderForCash,
  input: { amountCents?: number; method: string; actor: string; paidAt?: Date }
) {
  if (order.readinessStatus === "CANCELED") throw conflict("This order is canceled");
  if (!order.customerId) {
    throw badRequest("Taking payment needs a customer from the catalog, not just a name");
  }
  if (order.totalCents <= 0) {
    throw badRequest("Cannot take payment for an order with no value — set unit prices on its lines");
  }

  // Same lock-then-read as an invoice payment, or two checkout captures both
  // see the full balance outstanding.
  await lockDocumentForPayment(tx, "SalesOrder", order.id);
  const held = (await unappliedDeposits(tx, order.id)).reduce((s, p) => s + p.amountCents, 0);
  const outstandingCents = order.totalCents - held;
  if (outstandingCents <= 0) throw conflict("This order is already paid in full");

  const amountCents = input.amountCents ?? outstandingCents;
  if (amountCents <= 0) throw badRequest("A payment has to be for a positive amount");
  if (amountCents > outstandingCents) {
    throw badRequest(`That is more than is owed: ${outstandingCents} remains on ${order.orderNumber}`);
  }

  const payment = await tx.payment.create({
    data: {
      paymentNumber: await nextPaymentNumber(tx),
      direction: "RECEIPT",
      amountCents,
      method: input.method,
      paidAt: input.paidAt ?? new Date(),
      status: "POSTED",
      salesOrderId: order.id,
      customerId: order.customerId,
    },
  });
  const entry = await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.CUSTOMER_DEPOSIT,
    amountCents,
    entryDate: input.paidAt,
    memo: `Checkout payment ${payment.paymentNumber} on ${order.orderNumber} — paid ahead; revenue when it ships`,
    referenceType: "PAYMENT",
    referenceId: payment.id,
    actor: input.actor,
  });

  if (amountCents === outstandingCents) {
    await tx.salesOrder.updateMany({
      where: { id: order.id, paymentStatus: "AWAITING_PAYMENT" },
      data: { paymentStatus: "PREPAID" },
    });
  }
  return { payment, entry, outstandingCents: outstandingCents - amountCents };
}

/**
 * Raise the invoice for an order and settle it from any checkout deposits.
 *
 * Called by /ship (the normal path: revenue when goods leave) and by the
 * manual /invoice route (billing in advance, e.g. a wholesale pro-forma).
 */
export async function raiseInvoice(tx: Tx, order: OrderForCash, actor: string, issued = new Date()) {
  if (!order.customerId) {
    throw badRequest("An invoice needs a customer from the catalog, not just a name");
  }
  if (order.totalCents <= 0) {
    throw badRequest("Cannot invoice an order with no value — set unit prices on its lines");
  }

  const claimed = await tx.salesOrder.updateMany({
    where: { id: order.id, paymentStatus: { in: ["AWAITING_PAYMENT", "PREPAID"] } },
    data: { paymentStatus: "INVOICED" },
  });
  if (claimed.count === 0) throw conflict("This order was already invoiced");

  const invoice = await tx.invoice.create({
    data: {
      invoiceNumber: await nextInvoiceNumber(tx),
      salesOrderId: order.id,
      customerId: order.customerId,
      issueDate: issued,
      dueDate: dueDateFor(order.channel, issued),
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      status: "POSTED",
    },
  });

  const entry = await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.SALES_INVOICE,
    amountCents: order.totalCents,
    memo: `Invoice ${invoice.invoiceNumber} for ${order.orderNumber}`,
    referenceType: "INVOICE",
    referenceId: invoice.id,
    actor,
  });

  // Checkout money now meets the receivable it was always for. Since
  // 2026-09-24 it was booked straight to Accounts Receivable, so linking the
  // payment is enough; only money taken earlier and held in the retired
  // Customer Deposits account still needs moving onto the invoice.
  const deposits = await unappliedDeposits(tx, order.id);
  const deposits2100 = await tx.journalLine.findMany({
    where: {
      account: { code: ACCOUNT.CUSTOMER_DEPOSITS },
      creditCents: { gt: 0 },
      journalEntry: { referenceType: "PAYMENT", referenceId: { in: deposits.map((d) => d.id) }, status: "POSTED" },
    },
    select: { journalEntry: { select: { referenceId: true } } },
  });
  const heldIn2100 = new Set(deposits2100.map((l) => l.journalEntry.referenceId));
  for (const d of deposits) {
    await tx.payment.update({ where: { id: d.id }, data: { invoiceId: invoice.id } });
    if (!heldIn2100.has(d.id)) continue;
    await postSimple(tx, {
      transactionType: TRANSACTION_TYPE.DEPOSIT_APPLIED,
      amountCents: d.amountCents,
      memo: `Apply ${d.paymentNumber} to ${invoice.invoiceNumber}`,
      referenceType: "DEPOSIT_APPLICATION",
      referenceId: d.id,
      actor,
    });
  }

  await recognizeCogs(tx, order.id, actor);

  const paid = await paidAgainst(tx, { invoiceId: invoice.id });
  if (paid >= invoice.totalCents) {
    await tx.salesOrder.update({ where: { id: order.id }, data: { paymentStatus: "PAID" } });
  }

  return { invoice, entry, appliedDeposits: deposits.length };
}

/**
 * Match the cost of shipped goods to the invoice (client sheet 3.1 part B):
 * Dr Cost of Goods Sold / Cr Inventory Clearing – Outbound, once per shipment.
 *
 * A shipment already costed — by a live recognition, or by the legacy entry
 * that posted COGS straight off Inventory before this rule existed — is
 * skipped, so it is safe to call from both /ship and /invoice.
 */
export async function recognizeCogs(tx: Tx, salesOrderId: number, actor: string) {
  const shipments = await tx.shipment.findMany({
    where: { salesOrderId, status: { not: "VOID" }, cogsCents: { gt: 0 } },
  });
  for (const sh of shipments) {
    const legacy = await tx.journalEntry.count({
      where: { referenceType: "SHIPMENT", referenceId: sh.id, transactionType: "SALES_SHIPMENT_COGS", status: "POSTED" },
    });
    const posted = await tx.journalEntry.count({
      where: { referenceType: "SHIPMENT_COGS", referenceId: sh.id, transactionType: "INVOICE_COGS", status: "POSTED" },
    });
    const reversed = await tx.journalEntry.count({
      where: { referenceType: "SHIPMENT_COGS", referenceId: sh.id, transactionType: "INVOICE_COGS_REVERSAL", status: "POSTED" },
    });
    if (legacy > 0 || posted > reversed) continue;
    await postSimple(tx, {
      transactionType: TRANSACTION_TYPE.INVOICE_COGS,
      amountCents: sh.cogsCents,
      memo: `Cost of goods sold for ${sh.shipmentNumber}`,
      referenceType: "SHIPMENT_COGS",
      referenceId: sh.id,
      actor,
    });
  }
}

/**
 * An order is DELIVERED when every shipment on it has a confirmed delivery,
 * and drops back to SHIPPED if one is retracted. Derived from the shipments,
 * so the order can never claim more than they do.
 */
export async function syncDelivered(tx: Tx, salesOrderId: number) {
  const shipments = await tx.shipment.findMany({
    where: { salesOrderId, status: { not: "VOID" } },
    select: { deliveredAt: true },
  });
  const all = shipments.length > 0 && shipments.every((s) => s.deliveredAt !== null);
  await tx.salesOrder.updateMany({
    where: { id: salesOrderId, readinessStatus: all ? "SHIPPED" : "DELIVERED" },
    data: { readinessStatus: all ? "DELIVERED" : "SHIPPED" },
  });
}

export { channelPolicy };
