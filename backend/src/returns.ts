import type { Tx } from "./inventory";
import { applyBalanceDelta, recordMovement } from "./inventory";
import { createLot } from "./costing";
import { postSimple } from "./ledger";
import { TRANSACTION_TYPE } from "./accounts";
import { badRequest, conflict, notFound } from "./errors";
import { lockDocumentForPayment, paidAgainst } from "./payments";
import { nextPaymentNumber, nextReturnNumber } from "./numbering";

/**
 * Customer returns.
 *
 * An e-commerce brand sees returns every week, and before this the only tool was
 * "reverse the payment", which is an error correction: it pretends the money
 * never arrived and leaves the goods and the revenue where they were. A return
 * is three real events, posted together:
 *
 *   goods back    RESTOCK:   new cost layer at the cost the units LEFT at
 *                            Dr Inventory / Cr COGS
 *                 WRITE_OFF: nothing — the damaged unit's cost stays in COGS
 *   credit note   Dr Sales Revenue / Cr Accounts Receivable, for the returned
 *                 lines at their sold price plus their share of the order's tax
 *   refund        only what the customer has paid BEYOND what they now owe
 *                 Dr Accounts Receivable / Cr Bank
 *
 * The credit note and refund are stored as Payment rows against the invoice
 * (method CREDIT_NOTE, and a NEGATIVE amount for the refund), so every existing
 * "outstanding = total − payments" calculation — the pay route, the dashboard,
 * the month-end close — stays right without learning about returns.
 */

export const CREDIT_NOTE = "CREDIT_NOTE";

export type ReturnInput = {
  reason: string;
  refundMethod?: string;
  lines: { lineId: number; quantity: number; disposition: "RESTOCK" | "WRITE_OFF"; warehouseId?: number }[];
};

export async function postReturn(tx: Tx, orderId: number, input: ReturnInput, actor: string) {
  const order = await tx.salesOrder.findUnique({
    where: { id: orderId },
    include: { lines: { include: { product: true, warehouse: true } }, invoices: true, shipments: true },
  });
  if (!order) throw notFound("Sales order not found");
  if (order.readinessStatus !== "SHIPPED" && order.readinessStatus !== "DELIVERED") {
    throw conflict("Only goods that have shipped can be returned — cancel an order that has not left");
  }
  const invoice = order.invoices.find((i) => i.status === "POSTED");
  if (!invoice) {
    throw conflict("This order has no invoice to credit. Invoice it first, then record the return.");
  }
  if (input.lines.length === 0) throw badRequest("A return needs at least one line");

  // Same lock-then-read as a payment: the refund below depends on what has
  // been paid, and two returns racing would both see the same balance.
  await lockDocumentForPayment(tx, "Invoice", invoice.id);

  const shipmentIds = order.shipments.filter((s) => s.status !== "VOID").map((s) => s.id);
  const seen = new Set<number>();
  const prepared: {
    line: (typeof order.lines)[number];
    quantity: number;
    disposition: "RESTOCK" | "WRITE_OFF";
    warehouseId: number | null;
    unitCostCents: number;
  }[] = [];

  for (const ask of input.lines) {
    const line = order.lines.find((l) => l.id === ask.lineId);
    if (!line) throw badRequest(`Line ${ask.lineId} is not on ${order.orderNumber}`);
    if (seen.has(line.id)) throw badRequest(`Line ${ask.lineId} appears twice`);
    seen.add(line.id);
    if (!Number.isInteger(ask.quantity) || ask.quantity <= 0) {
      throw badRequest(`${line.product.sku}: return a whole number of units`);
    }
    const returnable = line.quantity - line.returnedQty;
    if (ask.quantity > returnable) {
      throw badRequest(`${line.product.sku}: only ${returnable} unit(s) can still be returned`);
    }
    // A serial unit coming back needs its own serial checked in and its layer
    // restored. Until that exists, refuse rather than create stock with no
    // serial behind it — the exact defect fixed on the receiving side.
    if (line.product.trackingMode === "SERIAL") {
      throw badRequest(
        `${line.product.sku} is serial-tracked — returns of serialised units are not supported yet; use a repair order`
      );
    }

    let warehouseId: number | null = null;
    if (ask.disposition === "RESTOCK") {
      warehouseId = ask.warehouseId ?? line.warehouseId;
      const wh = await tx.warehouse.findUnique({ where: { id: warehouseId } });
      if (!wh) throw badRequest(`Warehouse ${warehouseId} not found`);
      if (!wh.isActive) throw badRequest(`${wh.code} is deactivated — restock to another warehouse`);
    }

    // The cost these units LEFT at, from the shipment's own movement. Restocking
    // at today's cost, or the product's default, would move value between
    // Inventory and COGS that no real event moved.
    const shipped = await tx.inventoryMovement.findMany({
      where: {
        movementType: "SALE_SHIP",
        referenceType: "SHIPMENT",
        referenceId: { in: shipmentIds },
        productId: line.productId,
        fromWarehouseId: line.warehouseId,
      },
      select: { quantity: true, totalCostCents: true },
    });
    const shippedQty = shipped.reduce((s, m) => s + m.quantity, 0);
    const shippedCost = shipped.reduce((s, m) => s + m.totalCostCents, 0);
    const unitCostCents = shippedQty > 0 ? Math.round(shippedCost / shippedQty) : 0;

    prepared.push({ line, quantity: ask.quantity, disposition: ask.disposition, warehouseId, unitCostCents });
  }

  // Claim the returned quantity atomically, so two returns of the same line
  // cannot together send back more than shipped.
  for (const p of prepared) {
    const claimed = await tx.salesOrderLine.updateMany({
      where: { id: p.line.id, returnedQty: { lte: p.line.quantity - p.quantity } },
      data: { returnedQty: { increment: p.quantity } },
    });
    if (claimed.count === 0) throw conflict(`${p.line.product.sku} was returned by another request`);
  }

  const goodsCents = prepared.reduce((s, p) => s + p.quantity * p.line.unitPriceCents, 0);
  const taxShare = order.subtotalCents > 0 ? Math.round((order.taxCents * goodsCents) / order.subtotalCents) : 0;
  const creditCents = goodsCents + taxShare;
  const restockCostCents = prepared
    .filter((p) => p.disposition === "RESTOCK")
    .reduce((s, p) => s + p.quantity * p.unitCostCents, 0);

  const returnNumber = await nextReturnNumber(tx);
  const salesReturn = await tx.salesReturn.create({
    data: {
      returnNumber,
      salesOrderId: order.id,
      invoiceId: invoice.id,
      reason: input.reason,
      creditCents,
      restockCostCents,
      actor,
      lines: {
        create: prepared.map((p) => ({
          salesOrderLineId: p.line.id,
          productId: p.line.productId,
          quantity: p.quantity,
          disposition: p.disposition,
          warehouseId: p.warehouseId,
          unitPriceCents: p.line.unitPriceCents,
          unitCostCents: p.unitCostCents,
        })),
      },
    },
  });

  // ---- goods back on the shelf ------------------------------------------
  for (const p of prepared.filter((x) => x.disposition === "RESTOCK")) {
    await createLot(tx, {
      productId: p.line.productId,
      warehouseId: p.warehouseId!,
      quantity: p.quantity,
      unitCostCents: p.unitCostCents,
      sourceType: "SALES_RETURN",
      sourceId: salesReturn.id,
    });
    await applyBalanceDelta(
      tx,
      p.line.productId,
      p.warehouseId!,
      { onHandQty: p.quantity },
      `Cannot restock ${p.line.product.sku}`
    );
    await recordMovement(tx, {
      productId: p.line.productId,
      toWarehouseId: p.warehouseId!,
      quantity: p.quantity,
      movementType: "RETURN_IN",
      reason: `Returned on ${returnNumber} (${order.orderNumber}): ${input.reason}`,
      referenceType: "SALES_RETURN",
      referenceId: salesReturn.id,
      totalCostCents: p.quantity * p.unitCostCents,
      actor,
    });
  }
  await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.RETURN_RESTOCK,
    amountCents: restockCostCents,
    memo: `Restock on ${returnNumber} (${order.orderNumber})`,
    referenceType: "SALES_RETURN",
    referenceId: salesReturn.id,
    actor,
  });

  // ---- credit note --------------------------------------------------------
  const creditNote = await tx.payment.create({
    data: {
      paymentNumber: await nextPaymentNumber(tx),
      direction: "CREDIT",
      amountCents: creditCents,
      method: CREDIT_NOTE,
      status: "POSTED",
      invoiceId: invoice.id,
      customerId: order.customerId,
    },
  });
  await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.SALES_RETURN,
    amountCents: creditCents,
    memo: `Credit note ${creditNote.paymentNumber} on ${returnNumber} against ${invoice.invoiceNumber}`,
    referenceType: "PAYMENT",
    referenceId: creditNote.id,
    actor,
  });

  // ---- refund: only what was paid beyond what is now owed -----------------
  const live = await tx.payment.findMany({
    where: { invoiceId: invoice.id, status: { not: "VOID" } },
    select: { amountCents: true, method: true, id: true },
    orderBy: { id: "asc" },
  });
  const credits = live.filter((p) => p.method === CREDIT_NOTE).reduce((s, p) => s + p.amountCents, 0);
  const cashNet = live.filter((p) => p.method !== CREDIT_NOTE).reduce((s, p) => s + p.amountCents, 0);
  const owed = invoice.totalCents - credits;
  const refundCents = Math.max(0, Math.min(cashNet, cashNet - owed));

  let refund = null;
  if (refundCents > 0) {
    const lastCash = [...live].reverse().find((p) => p.method !== CREDIT_NOTE && p.amountCents > 0);
    const method = input.refundMethod ?? lastCash?.method ?? "BANK";
    refund = await tx.payment.create({
      data: {
        paymentNumber: await nextPaymentNumber(tx),
        direction: "REFUND",
        // Negative on purpose: it is money going back, and every balance in the
        // app sums payments against the invoice.
        amountCents: -refundCents,
        method,
        status: "POSTED",
        invoiceId: invoice.id,
        customerId: order.customerId,
      },
    });
    await postSimple(tx, {
      transactionType: TRANSACTION_TYPE.CUSTOMER_REFUND,
      amountCents: refundCents,
      memo: `Refund ${refund.paymentNumber} (${method}) on ${returnNumber}`,
      referenceType: "PAYMENT",
      referenceId: refund.id,
      actor,
    });
  }

  await tx.salesReturn.update({
    where: { id: salesReturn.id },
    data: { refundCents, refundMethod: refund?.method ?? null },
  });

  // Settled means nothing is owed either way.
  const net = await paidAgainst(tx, { invoiceId: invoice.id });
  await tx.salesOrder.update({
    where: { id: order.id },
    data: { paymentStatus: net >= invoice.totalCents ? "PAID" : "INVOICED" },
  });

  return {
    salesReturn: await tx.salesReturn.findUniqueOrThrow({ where: { id: salesReturn.id }, include: { lines: true } }),
    creditCents,
    refundCents,
    restockCostCents,
  };
}
