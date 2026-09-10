import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { applyBalanceDelta, claimStatusTransition, recordMovement, reserveStock } from "../inventory";
import { attachConsumptionsToMovement, consumeFifo } from "../costing";
import { postSimple, reverseDocumentEntry } from "../ledger";
import { TRANSACTION_TYPE } from "../accounts";
import { assertReferencesUsable } from "../refs";
import {
  nextInvoiceNumber,
  nextPaymentNumber,
  nextSalesOrderNumber,
  nextShipmentNumber,
} from "../numbering";

export const salesOrdersRouter = Router();

const createSchema = z.object({
  customerId: z.number().int().positive().optional(),
  customerName: z.string().min(1).optional(),
  employeeId: z.number().int().positive().optional(),
  channel: z.string().optional(),
  notes: z.string().optional().nullable(),
  taxCents: z.number().int().min(0).optional(),
  shippingCents: z.number().int().min(0).optional(),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().min(0).optional(),
      })
    )
    .min(1, "A sales order needs at least one line"),
});

const include = {
  lines: { include: { product: true, warehouse: true } },
  customer: true,
  employee: true,
  invoices: true,
  shipments: true,
};

salesOrdersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const readinessStatus = String(req.query.readinessStatus ?? "").trim();
    const paymentStatus = String(req.query.paymentStatus ?? "").trim();
    const channel = String(req.query.channel ?? "").trim();
    const search = String(req.query.search ?? "").trim();

    const where = {
      ...(readinessStatus ? { readinessStatus } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(channel ? { channel } : {}),
      ...(search
        ? { OR: [{ orderNumber: contains(search) }, { customerName: contains(search) }] }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.salesOrder.count({ where }),
      prisma.salesOrder.findMany({ where, skip, take, include, orderBy: { createdAt: "desc" } }),
    ]);

    res.json({
      data: rows.map((o) => ({
        ...o,
        totalQuantity: o.lines.reduce((s, l) => s + l.quantity, 0),
        lineCount: o.lines.length,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);

salesOrdersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const order = await prisma.salesOrder.findUnique({ where: { id }, include });
    if (!order) throw notFound("Sales order not found");
    res.json({ ...order, totalQuantity: order.lines.reduce((s, l) => s + l.quantity, 0) });
  })
);

salesOrdersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);

    const order = await prisma.$transaction(async (tx) => {
      await assertReferencesUsable(tx, body.lines);

      // A customer may be named freely on a direct order, but if an id is given
      // it has to resolve — and its name wins, so the catalog stays the truth.
      let customerName = body.customerName?.trim() ?? "";
      if (body.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: body.customerId } });
        if (!customer) throw notFound(`Customer ${body.customerId} not found`);
        if (!customer.isActive) throw badRequest(`Customer ${customer.name} is archived`);
        customerName = customer.name;
      }
      if (!customerName) throw badRequest("A sales order needs a customer");

      const products = await tx.product.findMany({
        where: { id: { in: body.lines.map((l) => l.productId) } },
      });
      const priceOf = (productId: number, given?: number) =>
        given ?? products.find((p) => p.id === productId)?.defaultPriceCents ?? 0;

      const lines = body.lines.map((l) => {
        const unitPriceCents = priceOf(l.productId, l.unitPriceCents);
        return {
          productId: l.productId,
          warehouseId: l.warehouseId,
          quantity: l.quantity,
          unitPriceCents,
          lineTotalCents: unitPriceCents * l.quantity,
          status: "PENDING",
        };
      });

      const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const taxCents = body.taxCents ?? 0;
      const shippingCents = body.shippingCents ?? 0;

      return tx.salesOrder.create({
        data: {
          orderNumber: await nextSalesOrderNumber(tx),
          customerId: body.customerId ?? null,
          customerName,
          employeeId: body.employeeId ?? null,
          channel: body.channel ?? "DIRECT",
          notes: body.notes ?? null,
          readinessStatus: "NOT_PACKED",
          paymentStatus: "AWAITING_PAYMENT",
          subtotalCents,
          taxCents,
          shippingCents,
          totalCents: subtotalCents + taxCents + shippingCents,
          lines: { create: lines },
        },
        include,
      });
    });

    res.status(201).json(order);
  })
);

/**
 * PACK reserves stock. Nothing physical has moved, so no movement row and no
 * ledger entry — only availability changes.
 */
salesOrdersRouter.post(
  "/:id/pack",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    const order = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus !== "NOT_PACKED") {
        throw conflict(`Only an unpacked order can be packed (this one is ${current.readinessStatus})`);
      }

      const claimed = await claimStatusTransition(
        (args) =>
          tx.salesOrder.updateMany({
            where: { id: args.where.id, readinessStatus: args.where.status },
            data: { readinessStatus: args.data.status },
          }),
        id,
        "NOT_PACKED",
        "PACKED"
      );
      if (!claimed) throw conflict("This order was already packed by another request");

      for (const line of current.lines) {
        await reserveStock(
          tx,
          line.productId,
          line.warehouseId,
          line.quantity,
          `Cannot reserve ${line.product.sku} at ${line.warehouse.code}`
        );
        await tx.salesOrderLine.update({ where: { id: line.id }, data: { status: "RESERVED" } });
      }

      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(order);
  })
);

/** Invoicing is a financial transaction: Dr Accounts Receivable, Cr Sales Revenue. */
salesOrdersRouter.post(
  "/:id/invoice",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus === "CANCELED") throw conflict("A canceled order cannot be invoiced");
      if (current.paymentStatus !== "AWAITING_PAYMENT") {
        throw conflict(`This order is already ${current.paymentStatus.toLowerCase().replace("_", " ")}`);
      }
      if (!current.customerId) {
        throw badRequest("An invoice needs a customer from the catalog, not just a name");
      }
      if (current.totalCents <= 0) {
        throw badRequest("Cannot invoice an order with no value — set unit prices on its lines");
      }

      // Claim the payment-status transition atomically, so a double-click
      // cannot post two invoices for the same order.
      const claimed = await tx.salesOrder.updateMany({
        where: { id, paymentStatus: "AWAITING_PAYMENT" },
        data: { paymentStatus: "INVOICED" },
      });
      if (claimed.count === 0) throw conflict("This order was already invoiced");

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber: await nextInvoiceNumber(tx),
          salesOrderId: current.id,
          customerId: current.customerId,
          subtotalCents: current.subtotalCents,
          taxCents: current.taxCents,
          shippingCents: current.shippingCents,
          totalCents: current.totalCents,
          status: "POSTED",
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.SALES_INVOICE,
        amountCents: current.totalCents,
        memo: `Invoice ${invoice.invoiceNumber} for ${current.orderNumber}`,
        referenceType: "INVOICE",
        referenceId: invoice.id,
        actor,
      });

      return { invoice, entry, order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }) };
    });

    res.status(201).json(result);
  })
);

/** Payment: Dr Bank, Cr Accounts Receivable. */
salesOrdersRouter.post(
  "/:id/pay",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const method = String(req.body?.method ?? "BANK");

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.paymentStatus !== "INVOICED") {
        throw conflict(`Only an invoiced order can be paid (this one is ${current.paymentStatus})`);
      }
      // Collecting money for an order that will never ship is the one
      // incoherent combination the two status axes make possible.
      if (current.readinessStatus === "CANCELED") {
        throw conflict("This order is canceled — void its invoice rather than taking payment");
      }
      const invoice = current.invoices.find((i) => i.status === "POSTED");
      if (!invoice) throw badRequest("No posted invoice found for this order");

      const claimed = await tx.salesOrder.updateMany({
        where: { id, paymentStatus: "INVOICED" },
        data: { paymentStatus: "PAID" },
      });
      if (claimed.count === 0) throw conflict("This order was already paid");

      const payment = await tx.payment.create({
        data: {
          paymentNumber: await nextPaymentNumber(tx),
          direction: "RECEIPT",
          amountCents: invoice.totalCents,
          method,
          status: "POSTED",
          invoiceId: invoice.id,
          customerId: current.customerId,
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.SALES_PAYMENT,
        amountCents: invoice.totalCents,
        memo: `Payment ${payment.paymentNumber} against ${invoice.invoiceNumber}`,
        referenceType: "PAYMENT",
        referenceId: payment.id,
        actor,
      });

      return { payment, entry, order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }) };
    });

    res.status(201).json(result);
  })
);

/**
 * SHIP is where inventory and the ledger meet: stock leaves, FIFO layers are
 * consumed, and the cost of those exact layers is booked as COGS.
 */
salesOrdersRouter.post(
  "/:id/ship",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus !== "PACKED") {
        throw conflict(`Only a packed order can ship (this one is ${current.readinessStatus})`);
      }

      const claimed = await claimStatusTransition(
        (args) =>
          tx.salesOrder.updateMany({
            where: { id: args.where.id, readinessStatus: args.where.status },
            data: { readinessStatus: args.data.status },
          }),
        id,
        "PACKED",
        "SHIPPED"
      );
      if (!claimed) throw conflict("This order was already shipped by another request");

      // Each line ships from its own warehouse. Naming one on the document
      // would be a lie for a multi-warehouse order, so it is only set when
      // every line agrees.
      const warehouseIds = new Set(current.lines.map((l) => l.warehouseId));
      const warehouseId = warehouseIds.size === 1 ? current.lines[0].warehouseId : null;
      const shipment = await tx.shipment.create({
        data: {
          shipmentNumber: await nextShipmentNumber(tx),
          salesOrderId: current.id,
          warehouseId,
          status: "POSTED",
        },
      });

      let cogsCents = 0;
      for (const line of current.lines) {
        await applyBalanceDelta(
          tx,
          line.productId,
          line.warehouseId,
          { onHandQty: -line.quantity, reservedQty: -line.quantity },
          `Cannot ship ${line.product.sku} from ${line.warehouse.code}`,
          // A shipment releases the reservation it is drawing down.
          { allowReserved: true }
        );

        const consumed = await consumeFifo(tx, {
          productId: line.productId,
          warehouseId: line.warehouseId,
          quantity: line.quantity,
          sourceType: "SHIPMENT",
          sourceId: shipment.id,
          context: `Cannot cost ${line.product.sku} at ${line.warehouse.code}`,
        });
        cogsCents += consumed.totalCostCents;

        const movement = await recordMovement(tx, {
          productId: line.productId,
          fromWarehouseId: line.warehouseId,
          quantity: line.quantity,
          movementType: "SALE_SHIP",
          reason: `Shipped on ${current.orderNumber}`,
          referenceType: "SHIPMENT",
          referenceId: shipment.id,
          totalCostCents: consumed.totalCostCents,
          actor,
        });
        await attachConsumptionsToMovement(tx, consumed.consumptionIds, movement.id);
        await tx.salesOrderLine.update({ where: { id: line.id }, data: { status: "SHIPPED" } });
      }

      await tx.shipment.update({ where: { id: shipment.id }, data: { cogsCents } });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.SALES_SHIPMENT_COGS,
        amountCents: cogsCents,
        memo: `COGS for ${shipment.shipmentNumber} (${current.orderNumber})`,
        referenceType: "SHIPMENT",
        referenceId: shipment.id,
        actor,
      });

      return {
        shipment: { ...shipment, cogsCents },
        entry,
        order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.json(result);
  })
);

/** Cancelling releases any reservation. Posted financials are never deleted. */
salesOrdersRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    const order = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus === "SHIPPED") throw conflict("A shipped order cannot be canceled");
      if (current.readinessStatus === "CANCELED") throw conflict("Order is already canceled");
      if (current.paymentStatus === "PAID") {
        throw conflict("This order is paid — refund and void the payment before canceling");
      }
      // An invoice has already put revenue and a receivable on the books.
      // Cancelling around it would leave both standing forever.
      if (current.paymentStatus === "INVOICED") {
        throw conflict(
          "This order is invoiced — void the invoice first so its revenue is reversed"
        );
      }

      const claimed = await claimStatusTransition(
        (args) =>
          tx.salesOrder.updateMany({
            where: { id: args.where.id, readinessStatus: args.where.status },
            data: { readinessStatus: args.data.status },
          }),
        id,
        current.readinessStatus,
        "CANCELED"
      );
      if (!claimed) throw conflict("This order was already changed by another request");

      if (current.readinessStatus === "PACKED") {
        for (const line of current.lines) {
          await applyBalanceDelta(
            tx,
            line.productId,
            line.warehouseId,
            { reservedQty: -line.quantity },
            `Cannot release reservation for ${line.product.sku}`
          );
        }
      }

      await tx.salesOrderLine.updateMany({ where: { salesOrderId: id }, data: { status: "CANCELED" } });
      if (current.paymentStatus === "AWAITING_PAYMENT") {
        await tx.salesOrder.update({ where: { id }, data: { paymentStatus: "VOIDED" } });
      }
      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(order);
  })
);

/**
 * Void a posted invoice by reversing its journal entry.
 *
 * Double-entry never deletes: the original entry stays and a mirror-image
 * contra entry cancels it, so the audit trail shows both.
 */
salesOrdersRouter.post(
  "/:id/void-invoice",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.paymentStatus === "PAID") {
        throw conflict("Refund and void the payment before voiding the invoice");
      }
      if (current.paymentStatus !== "INVOICED") {
        throw conflict(`There is no posted invoice to void (order is ${current.paymentStatus})`);
      }

      const claimed = await tx.salesOrder.updateMany({
        where: { id, paymentStatus: "INVOICED" },
        data: { paymentStatus: "AWAITING_PAYMENT" },
      });
      if (claimed.count === 0) throw conflict("This order was already changed");

      const invoice = current.invoices.find((i) => i.status === "POSTED");
      if (invoice) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });
        await reverseDocumentEntry(tx, "INVOICE", invoice.id, {
          actor,
          memo: `Void ${invoice.invoiceNumber}`,
        });
      }

      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(result);
  })
);

/** Only an untouched order can be deleted — nothing posted, nothing reserved. */
salesOrdersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const current = await prisma.salesOrder.findUnique({
      where: { id },
      include: { invoices: true, shipments: true },
    });
    if (!current) throw notFound("Sales order not found");
    if (current.invoices.length > 0 || current.shipments.length > 0) {
      throw badRequest("This order has posted documents and cannot be deleted");
    }
    if (current.readinessStatus === "PACKED") {
      throw badRequest("Cancel this order first so its reserved stock is released");
    }
    await prisma.salesOrder.delete({ where: { id } });
    res.json({ deleted: true });
  })
);
