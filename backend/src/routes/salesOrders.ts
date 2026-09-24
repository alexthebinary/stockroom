import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { requireMoney, requireStock } from "../auth";
import { companyDetails, renderAddressLabel, renderInvoice, renderPackingSlip } from "../pdf";
import { CARRIERS, trackingUrl } from "../carriers";
import { applyBalanceDelta, claimStatusTransition, recordMovement, reserveStock } from "../inventory";
import { consumeSerials } from "../serials";
import { attachConsumptionsToMovement, consumeFifo } from "../costing";
import { postSimple, reverseDocumentEntry } from "../ledger";
import { TRANSACTION_TYPE } from "../accounts";
import { assertReferencesUsable } from "../refs";
import { lockDocumentForPayment, paidAgainst } from "../payments";
import { CHANNELS, CHANNEL_CODES } from "../channels";
import { raiseInvoice, recognizeCogs, syncDelivered, takeDeposit, unappliedDeposits } from "../order_to_cash";
import { CREDIT_NOTE, postReturn } from "../returns";
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
  channel: z.enum(CHANNEL_CODES).optional(),
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

const paySchema = z.object({
  /// Omitted means "settle what is left", which is what every caller meant
  /// before this field existed.
  amountCents: z.number().int().optional(),
  method: z.string().optional(),
});

const reversePaymentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required — this reverses money already recorded"),
  /// Which instalment. Omitted reverses the most recent live one, which is the
  /// only thing that existed when an order could hold exactly one payment.
  paymentId: z.number().int().positive().optional(),
});


const include = {
  lines: { include: { product: true, warehouse: true } },
  customer: true,
  employee: true,
  invoices: true,
  shipments: true,
  deposits: { where: { status: { not: "VOID" } } },
  returns: { include: { lines: true }, orderBy: { id: "asc" as const } },
};

type LoadedOrder = Prisma.SalesOrderGetPayload<{ include: typeof include }>;

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
        ...withTrackingUrls(o),
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

/**
 * The carriers the UI offers as suggestions; free text is still accepted.
 *
 * Declared BEFORE "/:id" — Express matches in declaration order, so after it
 * this literal path is read as an order id and fails "id must be an integer".
 */
/** GET /api/sales-orders/channels — each channel and when its customers pay. */
salesOrdersRouter.get(
  "/channels",
  asyncHandler(async (_req, res) => {
    res.json({ channels: CHANNELS });
  })
);

salesOrdersRouter.get(
  "/shipping-carriers",
  asyncHandler(async (_req, res) => res.json({ carriers: CARRIERS }))
);

/**
 * A tracking link is derived, not stored, so it has to be attached on the way
 * out of every read. POST /tracking already did this for its own response and
 * the reads did not, which meant the link appeared when you saved a number and
 * vanished when you reloaded the page.
 */
function withTrackingUrls<T extends { shipments?: { carrier: string | null; trackingNumber: string | null }[] }>(
  order: T
) {
  if (!order.shipments) return order;
  return {
    ...order,
    shipments: order.shipments.map((s) => ({
      ...s,
      trackingUrl: trackingUrl(s.carrier, s.trackingNumber),
    })),
  };
}

/**
 * Invoices across every order.
 *
 * Declared BEFORE "/:id" — Express matches in declaration order and would
 * otherwise read "invoices" as an order id.
 *
 * This exists because "which invoices are unpaid" was previously answerable
 * only by opening sales orders one at a time. `outstanding` is computed here
 * rather than stored: a payment can be reversed, so a cached balance is a
 * second source of truth that goes stale silently.
 */
salesOrdersRouter.get(
  "/invoices",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const status = String(req.query.status ?? "").trim();
    const search = String(req.query.search ?? "").trim();
    const settlement = String(req.query.settlement ?? "").trim();

    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { invoiceNumber: contains(search) },
              { customer: { name: contains(search) } },
              { salesOrder: { orderNumber: contains(search) } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        ...(settlement ? {} : { skip, take }),
        orderBy: { issueDate: "desc" },
        include: {
          customer: true,
          salesOrder: { select: { id: true, orderNumber: true, readinessStatus: true } },
          payments: { where: { status: { not: "VOID" } } },
        },
      }),
    ]);

    const mapped = rows.map(({ payments, ...invoice }) => {
      const amountPaidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
      return {
        ...invoice,
        amountPaidCents,
        outstandingCents: Math.max(invoice.totalCents - amountPaidCents, 0),
      };
    });

    // Settlement is derived, so it cannot be a database filter without denormalising
    // it. Paging happens first and this narrows the page, which is honest for a
    // filter chip and wrong for a total — so the total is recomputed, not reused.
    /*
     * Settlement is derived from live payments, so it cannot be a database
     * filter without denormalising a balance that reversals would make stale.
     * It therefore filters the WHOLE candidate set and pages in memory.
     *
     * It used to post-filter one page of 25 and report that page's length as
     * the total: a page of 25 unpaid rows answered ?settlement=PAID with
     * `data: []`, `total: 0`, `totalPages: 1`, so the UI said "none match",
     * hid pagination, and every settled invoice further down was unreachable.
     */
    const filtered =
      settlement === "PAID"
        ? mapped.filter((i) => i.status !== "VOID" && i.outstandingCents === 0)
        : settlement === "UNPAID"
          ? mapped.filter((i) => i.status !== "VOID" && i.outstandingCents > 0)
          : mapped;

    const pagedOf = settlement ? filtered.slice(skip, skip + take) : filtered;
    const invoiceTotal = settlement ? filtered.length : total;

    res.json({
      data: pagedOf,
      page,
      pageSize,
      total: invoiceTotal,
      totalPages: Math.max(1, Math.ceil(invoiceTotal / pageSize)),
    });
  })
);

/**
 * Deliveries across every order.
 *
 * `delivered` is a three-way filter and not a boolean, because "in transit"
 * here means "nobody has told us it arrived" — Stockroom cannot observe a
 * delivery and must not imply that it can.
 */
salesOrdersRouter.get(
  "/shipments",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const delivered = String(req.query.delivered ?? "").trim();
    const carrier = String(req.query.carrier ?? "").trim();
    const search = String(req.query.search ?? "").trim();

    const where = {
      ...(delivered === "YES" ? { deliveredAt: { not: null } } : {}),
      ...(delivered === "NO" ? { deliveredAt: null } : {}),
      ...(carrier ? { carrier } : {}),
      ...(search
        ? {
            OR: [
              { shipmentNumber: contains(search) },
              { trackingNumber: contains(search) },
              { salesOrder: { orderNumber: contains(search) } },
              { salesOrder: { customerName: contains(search) } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.shipment.count({ where }),
      prisma.shipment.findMany({
        where,
        skip,
        take,
        orderBy: { shippedAt: "desc" },
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          salesOrder: {
            select: { id: true, orderNumber: true, customerName: true, paymentStatus: true },
          },
        },
      }),
    ]);

    res.json({
      data: rows.map((s) => ({ ...s, trackingUrl: trackingUrl(s.carrier, s.trackingNumber) })),
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
    res.json({
      ...withTrackingUrls(order),
      totalQuantity: order.lines.reduce((s, l) => s + l.quantity, 0),
    });
  })
);

type CreateOrderInput = z.infer<typeof createSchema>;

/** Create an order inside a transaction. Shared by POST / and the counter sale. */
async function createOrder(tx: Prisma.TransactionClient, body: CreateOrderInput) {
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
}

/** Reserve every line of an order against its warehouse. */
async function reserveLines(tx: Prisma.TransactionClient, current: LoadedOrder) {
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
}

salesOrdersRouter.post(
  "/",
  requireStock,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);

    const order = await prisma.$transaction(async (tx) => {
      return createOrder(tx, body);
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
  requireStock,
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

      await reserveLines(tx, current);

      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(order);
  })
);

/**
 * Invoice in advance of shipment — billing a wholesale buyer before the goods
 * leave, or a pro-forma. The normal path does not need this: /ship raises the
 * invoice itself, because that is when revenue is earned. Checkout deposits
 * already held are applied to it either way.
 */
salesOrdersRouter.post(
  "/:id/invoice",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus === "CANCELED") throw conflict("A canceled order cannot be invoiced");
      if (current.paymentStatus !== "AWAITING_PAYMENT" && current.paymentStatus !== "PREPAID") {
        throw conflict(`This order is already ${current.paymentStatus.toLowerCase().replace("_", " ")}`);
      }
      const { invoice, entry } = await raiseInvoice(tx, current, actor);
      return { invoice, entry, order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }) };
    });

    res.status(201).json(result);
  })
);

/** Payment: Dr Bank, Cr Accounts Receivable. */
salesOrdersRouter.post(
  "/:id/pay",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const body = parseBody(paySchema, req.body ?? {});
    const method = body.method ?? "BANK";

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      // Before shipment the money is a checkout deposit, not a payment against
      // revenue: nothing has been sold yet.
      if (current.paymentStatus === "AWAITING_PAYMENT") {
        const deposit = await takeDeposit(tx, current, { amountCents: body.amountCents, method, actor });
        return { ...deposit, order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }) };
      }
      if (current.paymentStatus === "PREPAID") throw conflict("This order was paid in full at checkout");
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

      // Recomputed inside the transaction rather than read from the order:
      // instalments land one at a time and a stale balance is how an invoice
      // quietly ends up overpaid.
      // Lock before reading, or two concurrent partial payments both read the
      // same balance and both pass the overpay check. See payments.ts.
      await lockDocumentForPayment(tx, "Invoice", invoice.id);
      const alreadyPaidCents = await paidAgainst(tx, { invoiceId: invoice.id });
      const outstandingCents = invoice.totalCents - alreadyPaidCents;
      if (outstandingCents <= 0) throw conflict("This invoice is already settled in full");

      const amountCents = body.amountCents ?? outstandingCents;
      if (amountCents <= 0) throw badRequest("A payment has to be for a positive amount");
      if (amountCents > outstandingCents) {
        // Taking more than is owed is a credit balance, which is a real
        // business event with its own accounting — not something to fake by
        // letting this number go negative.
        throw badRequest(
          `That is more than is owed: ${outstandingCents} remains on ${invoice.invoiceNumber}`
        );
      }

      const settles = amountCents === outstandingCents;
      if (settles) {
        const claimed = await tx.salesOrder.updateMany({
          where: { id, paymentStatus: "INVOICED" },
          data: { paymentStatus: "PAID" },
        });
        if (claimed.count === 0) throw conflict("This order was already paid");
      }

      const payment = await tx.payment.create({
        data: {
          paymentNumber: await nextPaymentNumber(tx),
          direction: "RECEIPT",
          amountCents,
          method,
          status: "POSTED",
          invoiceId: invoice.id,
          customerId: current.customerId,
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.SALES_PAYMENT,
        amountCents,
        memo: settles
          ? `Payment ${payment.paymentNumber} against ${invoice.invoiceNumber}`
          : `Part payment ${payment.paymentNumber} against ${invoice.invoiceNumber} (${amountCents} of ${invoice.totalCents})`,
        referenceType: "PAYMENT",
        referenceId: payment.id,
        actor,
      });

      return {
        payment,
        entry,
        outstandingCents: outstandingCents - amountCents,
        order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.status(201).json(result);
  })
);

const shipSchema = z.object({
  carrier: z.string().trim().min(1).max(40).optional(),
  trackingNumber: z.string().trim().min(1).max(60).optional(),
  /**
   * Which physical units are going out, per order line — required for any line
   * whose product is SERIAL-tracked.
   *
   * It lives on ship rather than pack because ship is where stock is consumed,
   * and the serial must be recorded in the same transaction that draws down its
   * cost layer. A UI is free to collect them at pack time and replay them here.
   */
  serials: z
    .array(
      z.object({
        lineId: z.number().int().positive(),
        serialNumbers: z.array(z.string().trim().min(1)).min(1),
      })
    )
    .optional(),
});

const trackingSchema = z.object({
  carrier: z.string().trim().max(40).optional().nullable(),
  trackingNumber: z.string().trim().max(60).optional().nullable(),
  delivered: z.boolean().optional(),
});

/**
 * Record carrier and tracking against a shipment after the fact, and confirm
 * delivery.
 *
 * Separate from /ship because the number usually arrives later, and because
 * this must never touch stock or the ledger: the goods left when they left.
 * This writes four fields and nothing else.
 */
salesOrdersRouter.post(
  "/shipments/:shipmentId/tracking",
  requireStock,
  asyncHandler(async (req, res) => {
    const shipmentId = intParam(req.params.shipmentId, "shipmentId");
    const body = parseBody(trackingSchema, req.body ?? {});

    const current = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!current) throw notFound("Shipment not found");

    const shipment = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        ...(body.carrier !== undefined ? { carrier: body.carrier || null } : {}),
        ...(body.trackingNumber !== undefined ? { trackingNumber: body.trackingNumber || null } : {}),
        // Delivery is a fact someone asserts, so it can be asserted and
        // retracted. Stockroom has no way to observe it.
        ...(body.delivered !== undefined
          ? { deliveredAt: body.delivered ? (current.deliveredAt ?? new Date()) : null }
          : {}),
      },
    });

    if (body.delivered !== undefined) {
      await prisma.$transaction((tx) => syncDelivered(tx, shipment.salesOrderId));
    }

    res.json({ ...shipment, trackingUrl: trackingUrl(shipment.carrier, shipment.trackingNumber) });
  })
);

/**
 * An invoice as a PDF.
 *
 * This is the document that leaves the building, so it is rendered server-side
 * rather than printed from the browser: the recipient gets the same bytes
 * regardless of who opened what where.
 */
salesOrdersRouter.get(
  "/invoices/:invoiceId/pdf",
  asyncHandler(async (req, res) => {
    const invoiceId = intParam(req.params.invoiceId, "invoiceId");
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: true,
        salesOrder: { include: { lines: { include: { product: true } } } },
        payments: true,
      },
    });
    if (!invoice) throw notFound("Invoice not found");

    // Derived, never stored: a voided payment must stop counting against the
    // balance the moment it is voided.
    const amountPaidCents = invoice.payments
      .filter((p) => p.status !== "VOID")
      .reduce((sum, p) => sum + p.amountCents, 0);

    renderInvoice(res, { ...invoice, amountPaidCents }, companyDetails());
  })
);

/**
 * The shipment documents.
 *
 * Both are rendered from the same record and the same query, so a slip and the
 * label that goes on the same carton can never disagree about what is in it.
 *
 * NOT carrier postage. Stockroom buys nothing, validates no address and shops
 * no rate (see carriers.ts) — the label identifies a parcel on a shelf and on a
 * van, and a carrier's own scannable label goes on beside it.
 */
const shipmentForDocument = (shipmentId: number) =>
  prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      warehouse: true,
      salesOrder: {
        include: {
          customer: true,
          lines: { include: { product: true, warehouse: true } },
        },
      },
    },
  });

salesOrdersRouter.get(
  "/shipments/:shipmentId/packing-slip.pdf",
  asyncHandler(async (req, res) => {
    const shipmentId = intParam(req.params.shipmentId, "shipmentId");
    const shipment = await shipmentForDocument(shipmentId);
    if (!shipment) throw notFound("Shipment not found");
    renderPackingSlip(res, shipment, companyDetails());
  })
);

salesOrdersRouter.get(
  "/shipments/:shipmentId/label.pdf",
  asyncHandler(async (req, res) => {
    const shipmentId = intParam(req.params.shipmentId, "shipmentId");
    const shipment = await shipmentForDocument(shipmentId);
    if (!shipment) throw notFound("Shipment not found");
    renderAddressLabel(res, shipment, companyDetails());
  })
);

/**
 * REVERSE A PAYMENT — an error correction, not a refund.
 *
 * These are two different business events and collapsing them into one verb is
 * how an AR ledger stops being auditable. This route is for money that should
 * never have been recorded against this order: a keying error, the wrong
 * customer, a cheque that bounced. It posts the mirror contra, voids the
 * payment and returns the order to INVOICED so it can be cancelled or re-paid.
 *
 * Money the customer is genuinely getting back is a REFUND: a new outbound
 * payment belonging to a returns flow, which does not exist yet and must not
 * be faked with this route.
 */
salesOrdersRouter.post(
  "/:id/reverse-payment",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const body = parseBody(reversePaymentSchema, req.body ?? {});
    const reason = body.reason;

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      // Deliberately NOT gated on PAID. Once an invoice can be part paid, a
      // mis-keyed deposit sits on an order that never reached PAID, and the old
      // guard made exactly that mistake impossible to undo.
      const invoiceIds = current.invoices.map((i) => i.id);
      // A payment belongs to the order either through its invoice or, when it
      // was taken at checkout, directly as a deposit.
      // Credit notes and refunds are part of a RETURN, not payments to undo
      // one at a time; reversing one alone would unbalance the return.
      const belongs = {
        OR: [{ invoiceId: { in: invoiceIds } }, { salesOrderId: id }],
        method: { not: CREDIT_NOTE },
        amountCents: { gt: 0 },
      };
      const payment = body.paymentId
        ? await tx.payment.findFirst({
            where: { id: body.paymentId, ...belongs, status: { not: "VOID" } },
          })
        : await tx.payment.findFirst({
            where: { ...belongs, status: { not: "VOID" } },
            orderBy: { id: "desc" },
          });
      if (!payment) {
        throw conflict(
          body.paymentId
            ? `Payment ${body.paymentId} is not a live payment on this order`
            : "There is no live payment on this order to reverse"
        );
      }

      // Reversing any instalment means the invoice is no longer settled, so a
      // PAID order becomes payable again. A part-paid order is already INVOICED
      // and stays there.
      if (current.paymentStatus === "PAID") {
        const claimed = await tx.salesOrder.updateMany({
          where: { id, paymentStatus: "PAID" },
          data: { paymentStatus: "INVOICED" },
        });
        if (claimed.count === 0) throw conflict("This order was already changed");
      }
      // A full checkout payment reversed before shipment: nothing is paid now.
      if (current.paymentStatus === "PREPAID") {
        await tx.salesOrder.updateMany({
          where: { id, paymentStatus: "PREPAID" },
          data: { paymentStatus: "AWAITING_PAYMENT" },
        });
      }

      // Void the payment BEFORE reversing its entry: unpostEntry now refuses an
      // entry whose document still reads posted, and reverseDocumentEntry runs
      // through the same document check.
      // Claim the void atomically. A plain update let two concurrent reversals of
      // the same payment both pass the lookup above and both post a reversal —
      // the bank credited twice. SQLite serialises writes so no test could see it;
      // Postgres (production) does not. Found by an agy review, 2026-09-23.
      const voided = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: "VOID" } },
        data: { status: "VOID" },
      });
      if (voided.count === 0) throw conflict(`Payment ${payment.paymentNumber} was already reversed`);

      const reversal = await reverseDocumentEntry(tx, "PAYMENT", payment.id, {
        actor,
        memo: `Payment ${payment.paymentNumber} reversed: ${reason}`,
      });
      // A checkout deposit that was applied to the invoice moved Deposits into
      // AR as well. Undo both legs, or Customer Deposits is left negative.
      if (payment.salesOrderId && payment.invoiceId) {
        await reverseDocumentEntry(tx, "DEPOSIT_APPLICATION", payment.id, {
          actor,
          memo: `Application of ${payment.paymentNumber} reversed: ${reason}`,
        });
      }

      return {
        payment: await tx.payment.findUniqueOrThrow({ where: { id: payment.id } }),
        reversal,
        order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.json(result);
  })
);

type ShipInput = z.infer<typeof shipSchema>;

/**
 * Ship a packed order: stock leaves, FIFO layers are consumed, COGS is booked,
 * and the invoice is raised. Shared by /ship and the showroom counter sale, so
 * a sale made at the counter is costed exactly like one that left in a van.
 */
async function shipPacked(tx: Prisma.TransactionClient, current: LoadedOrder, shipInput: ShipInput, actor: string) {
  const id = current.id;
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
      // Optional, because the tracking number often arrives after the van
      // has gone. /tracking below fills it in later without reopening the
      // shipment or touching stock.
      carrier: shipInput.carrier ?? null,
      trackingNumber: shipInput.trackingNumber ?? null,
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

    // 🔴 SERIALIZED PRODUCTS TAKE A DIFFERENT PATH ON PURPOSE.
    // consumeFifo is quantity-driven and oldest-layer-first. For a serialized
    // product that would ship SOME unit, cost it correctly, and record the
    // WRONG serial against the shipment — the customer holds serial X while
    // our warranty lookup says Y. Silent until a claim. So a serialized line
    // must name its units, and consumption resolves to exactly those layers.
    const serialized = line.product.trackingMode === "SERIAL";
    let consumed: { totalCostCents: number; consumptionIds: number[] };

    if (serialized) {
      const named = shipInput.serials?.find((s) => s.lineId === line.id);
      if (!named) {
        throw badRequest(
          `${line.product.sku} is serial-tracked — name the ${line.quantity} unit(s) being shipped on this line`,
          { action: "scan-serials", lineId: line.id, quantity: line.quantity }
        );
      }
      if (named.serialNumbers.length !== line.quantity) {
        throw badRequest(
          `${line.product.sku}: ${named.serialNumbers.length} serial(s) named for a line of ${line.quantity}`,
          { action: "scan-serials", lineId: line.id, quantity: line.quantity }
        );
      }
      consumed = await consumeSerials(tx, {
        productId: line.productId,
        warehouseId: line.warehouseId,
        serialNumbers: named.serialNumbers,
        sourceType: "SHIPMENT",
        sourceId: shipment.id,
        context: `Cannot ship ${line.product.sku} from ${line.warehouse.code}`,
        toStatus: "SOLD",
      });
    } else {
      consumed = await consumeFifo(tx, {
        productId: line.productId,
        warehouseId: line.warehouseId,
        quantity: line.quantity,
        sourceType: "SHIPMENT",
        sourceId: shipment.id,
        context: `Cannot cost ${line.product.sku} at ${line.warehouse.code}`,
      });
    }
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

  // Client sheet 3.3 — goods issue: on-hand Inventory into outbound clearing
  // at the FIFO cost of the exact layers consumed.
  const entry = await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.GOODS_ISSUE,
    amountCents: cogsCents,
    memo: `Goods issue ${shipment.shipmentNumber} (${current.orderNumber})`,
    referenceType: "SHIPMENT",
    referenceId: shipment.id,
    actor,
  });

  // Revenue is earned as the goods leave, so the invoice is raised here, in the
  // same transaction — and raising it recognises this shipment's cost (sheet
  // 3.1 part B), clearing outbound. An order billed in advance already has an
  // invoice, so its cost is recognised now. An order with no catalog customer or
  // no value cannot be invoiced; it ships, its cost waits in outbound clearing,
  // and the close rulebook reports it as shipped-not-invoiced.
  const invoiceable =
    (current.paymentStatus === "AWAITING_PAYMENT" || current.paymentStatus === "PREPAID") &&
    current.customerId !== null &&
    current.totalCents > 0;
  if (invoiceable) await raiseInvoice(tx, current, actor);
  else if (current.invoices.some((i) => i.status === "POSTED")) await recognizeCogs(tx, current.id, actor);

  return { shipment: { ...shipment, cogsCents }, entry };
}

/**
 * SHIP is where inventory and the ledger meet: stock leaves, FIFO layers are
 * consumed, and the cost of those exact layers is booked as COGS.
 */
salesOrdersRouter.post(
  "/:id/ship",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const shipInput = parseBody(shipSchema, req.body ?? {});

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      const { shipment, entry } = await shipPacked(tx, current, shipInput, actor);

      return {
        shipment,
        entry,
        order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.json(result);
  })
);

const counterSaleSchema = createSchema.omit({ channel: true, customerName: true }).extend({
  /// A new client met in the showroom. Ignored when customerId is given.
  client: z
    .object({
      name: z.string().trim().min(1),
      email: z.string().trim().email().optional().nullable(),
      phone: z.string().trim().optional().nullable(),
    })
    .optional(),
  method: z.enum(["CARD", "CASH", "BANK"]).default("CARD"),
  serials: shipSchema.shape.serials,
});

/**
 * A showroom sale: the client pays at the counter and leaves with the goods.
 *
 * One request, one transaction, and every step is the ordinary one — the
 * order is created on the SHOWROOM channel, reserved, paid (a checkout
 * deposit), shipped (FIFO cost, COGS, and the invoice that applies the
 * deposit), and marked delivered because the client carried it out. Nothing
 * here is a shortcut through the books, so the counter sale reconciles exactly
 * like an order that left in a van. The response carries the invoice, whose
 * PDF is the paid in-store invoice handed to the client.
 */
salesOrdersRouter.post(
  "/counter-sale",
  requireStock,
  requireMoney,
  asyncHandler(async (req, res) => {
    const body = parseBody(counterSaleSchema, req.body);
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      let customerId = body.customerId;
      if (!customerId) {
        // A named new client joins the catalog, because they are a real client
        // with an invoice in their name. An unnamed sale goes to one shared
        // walk-in record rather than inventing a customer per receipt.
        const name = body.client?.name ?? "Walk-in client";
        const existing = body.client ? null : await tx.customer.findFirst({ where: { name } });
        customerId = (
          existing ??
          (await tx.customer.create({
            data: { name, email: body.client?.email ?? null, phone: body.client?.phone ?? null },
          }))
        ).id;
      }

      const created = await createOrder(tx, {
        ...body,
        customerId,
        channel: "SHOWROOM",
      });
      await tx.salesOrder.update({ where: { id: created.id }, data: { readinessStatus: "PACKED" } });
      await reserveLines(tx, created);

      const packed = await tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include });
      const { payment } = await takeDeposit(tx, packed, { method: body.method ?? "CARD", actor });

      const paid = await tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include });
      const { shipment } = await shipPacked(
        tx,
        paid,
        { carrier: "Collected in store", serials: body.serials },
        actor
      );
      await tx.shipment.update({ where: { id: shipment.id }, data: { deliveredAt: new Date() } });
      await syncDelivered(tx, created.id);

      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: created.id }, include });
      const invoice = order.invoices.find((i) => i.status === "POSTED");
      return { order, invoice, shipment, payment };
    });

    res.status(201).json(result);
  })
);

const returnSchema = z.object({
  reason: z.string().trim().min(1, "Say why it came back — it is the first question anyone asks later"),
  refundMethod: z.enum(["CARD", "CASH", "BANK"]).optional(),
  lines: z
    .array(
      z.object({
        lineId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        disposition: z.enum(["RESTOCK", "WRITE_OFF"]),
        warehouseId: z.number().int().positive().optional(),
      })
    )
    .min(1, "Return at least one line"),
});

/**
 * POST /api/sales-orders/:id/returns — goods back, credit note, refund. See
 * returns.ts. Needs both capabilities: it moves stock and it moves money.
 */
salesOrdersRouter.post(
  "/:id/returns",
  requireStock,
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const body = parseBody(returnSchema, req.body);
    const actor = actorOf(req);
    const result = await prisma.$transaction(async (tx) => {
      const posted = await postReturn(tx, id, body, actor);
      return { ...posted, order: await tx.salesOrder.findUniqueOrThrow({ where: { id }, include }) };
    });
    res.status(201).json(result);
  })
);

/** Cancelling releases any reservation. Posted financials are never deleted. */
salesOrdersRouter.post(
  "/:id/cancel",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    const order = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.readinessStatus === "SHIPPED" || current.readinessStatus === "DELIVERED") {
        throw conflict("A shipped order cannot be canceled");
      }
      // Checkout money is owed back to the customer. Cancelling around it
      // would leave the deposit on the books with no order to ship.
      const held = await unappliedDeposits(tx, id);
      if (held.length > 0) {
        throw conflict(
          `This order holds checkout payment ${held[held.length - 1].paymentNumber}. Reverse it (refund the customer) first, then cancel.`,
          { action: "reverse-payment", salesOrderId: current.id, paymentNumber: held[held.length - 1].paymentNumber }
        );
      }
      if (current.readinessStatus === "CANCELED") throw conflict("Order is already canceled");
      if (current.paymentStatus === "PAID") {
        // Naming an action without saying where it lives is a dead end: until
        // now this told the user to void a payment and gave them nothing to
        // click. The details carry the payment so the UI can offer it.
        const live = await tx.payment.findFirst({
          where: { invoiceId: { in: current.invoices.map((i) => i.id) }, status: { not: "VOID" } },
          orderBy: { id: "desc" },
        });
        throw conflict(
          live
            ? `This order is paid by ${live.paymentNumber}. Reverse that payment first, then cancel.`
            : "This order is paid — reverse the payment before canceling",
          live ? { action: "reverse-payment", salesOrderId: current.id, paymentNumber: live.paymentNumber } : undefined
        );
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
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.salesOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Sales order not found");
      if (current.paymentStatus === "PAID") {
        throw conflict("Refund and void the payment before voiding the invoice");
      }
      /*
       * PAID is no longer the only state holding money. Once an invoice can be
       * PART paid the order sits at INVOICED with a live payment against it,
       * and this guard used to wave that through: the invoice was voided and
       * its entry reversed while the customer's payment stayed posted, leaving
       * cash in the bank credited to a receivable that no longer exists and
       * Accounts Receivable driven negative.
       */
      const livePayments = await tx.payment.count({
        where: {
          invoiceId: { in: current.invoices.map((i) => i.id) },
          status: { not: "VOID" },
        },
      });
      if (livePayments > 0) {
        throw conflict(
          "There is a payment recorded against this invoice — reverse it before voiding"
        );
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
        // The cost matched to that invoice goes back to waiting in outbound
        // clearing, so revenue and its cost leave the P&L together.
        for (const sh of current.shipments) {
          await reverseDocumentEntry(tx, "SHIPMENT_COGS", sh.id, {
            actor,
            memo: `Cost of ${sh.shipmentNumber} back to outbound clearing (void ${invoice.invoiceNumber})`,
          });
        }
      }

      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(result);
  })
);

/** Only an untouched order can be deleted — nothing posted, nothing reserved. */
salesOrdersRouter.delete(
  "/:id",
  requireStock,
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
