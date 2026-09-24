import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { requireMoney, requireStock } from "../auth";
import { applyBalanceDelta, recordMovement } from "../inventory";
import { outstandingOf, receiveAgainstOrder } from "../goods_receipt";
import { lockDocumentForPayment, paidAgainst } from "../payments";
import { companyDetails, renderGoodsReceipt } from "../pdf";
import { createEntry, postSimple, reverseDocumentEntry, type DraftLine } from "../ledger";
import { ACCOUNT } from "../accounts";
import { TRANSACTION_TYPE } from "../accounts";
import { assertReferencesUsable } from "../refs";
import {
  nextBillNumber,
  nextGrnNumber,
  nextPaymentNumber,
  nextPurchaseOrderNumber,
} from "../numbering";

export const purchaseOrdersRouter = Router();

const createSchema = z.object({
  vendorId: z.number().int().positive().optional(),
  supplierName: z.string().min(1).optional(),
  employeeId: z.number().int().positive().optional(),
  notes: z.string().optional().nullable(),
  taxCents: z.number().int().min(0).optional(),
  shippingCents: z.number().int().min(0).optional(),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        quantity: z.number().int().positive(),
        unitCostCents: z.number().int().min(0).optional(),
      })
    )
    .min(1, "A purchase order needs at least one line"),
});

const receiveSchema = z.object({
  /// Omitted receives everything still outstanding, which is what every caller
  /// meant before a receipt could be partial.
  lines: z
    .array(
      z.object({
        lineId: z.number().int().positive(),
        quantity: z.number().int().min(0),
      })
    )
    .optional(),
});

const reversePaymentSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required — this reverses money already recorded"),
  /// Which instalment. Omitted reverses the most recent live one, which is
  /// all that existed before a bill could be part paid.
  paymentId: z.number().int().positive().optional(),
});

const payBillSchema = z.object({
  /// Omitted means "settle what is left", which is what every caller meant
  /// before this field existed.
  amountCents: z.number().int().optional(),
  method: z.string().optional(),
});


const include = {
  lines: { include: { product: true, warehouse: true } },
  vendor: true,
  employee: true,
  bills: true,
  goodsReceipts: true,
};

purchaseOrdersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const status = String(req.query.status ?? "").trim();
    const search = String(req.query.search ?? "").trim();

    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? { OR: [{ poNumber: contains(search) }, { supplierName: contains(search) }] }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.findMany({ where, skip, take, include, orderBy: { createdAt: "desc" } }),
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

/**
 * Bills across every purchase order — the inbound mirror of
 * GET /sales-orders/invoices.
 *
 * Declared BEFORE "/:id", or Express reads "bills" as an order id.
 *
 * `outstanding` is computed per request from live payments rather than stored:
 * a payment can be reversed, and a cached balance is a second source of truth
 * that goes stale silently.
 */
purchaseOrdersRouter.get(
  "/bills",
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
              { billNumber: contains(search) },
              { vendor: { name: contains(search) } },
              { purchaseOrder: { poNumber: contains(search) } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.bill.count({ where }),
      prisma.bill.findMany({
        where,
        ...(settlement ? {} : { skip, take }),
        orderBy: { issueDate: "desc" },
        include: {
          vendor: true,
          purchaseOrder: { select: { id: true, poNumber: true, status: true } },
          payments: { where: { status: { not: "VOID" } } },
        },
      }),
    ]);

    const mapped = rows.map(({ payments, ...bill }) => {
      const amountPaidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
      return {
        ...bill,
        amountPaidCents,
        outstandingCents: Math.max(bill.totalCents - amountPaidCents, 0),
      };
    });

    // Settlement is derived, so it cannot be a database filter without
    // denormalising it. Paging happens first and this narrows the page, which
    // is honest for a filter chip and wrong for a total — so the total is
    // recomputed, and the response says the filter was partial.
    /*
     * Settlement is derived from live payments, so it cannot be a database
     * filter without denormalising a balance that reversals would make stale.
     * It therefore filters the WHOLE candidate set and pages in memory.
     *
     * It used to post-filter one page of 25 and report that page's length as
     * the total: a page of 25 unpaid rows answered ?settlement=PAID with
     * `data: []`, `total: 0`, `totalPages: 1`, so the UI said "none match",
     * hid pagination, and every settled bill further down was unreachable.
     */
    const filtered =
      settlement === "PAID"
        ? mapped.filter((b) => b.status !== "VOID" && b.outstandingCents === 0)
        : settlement === "UNPAID"
          ? mapped.filter((b) => b.status !== "VOID" && b.outstandingCents > 0)
          : mapped;

    const pagedOf = settlement ? filtered.slice(skip, skip + take) : filtered;
    const billTotal = settlement ? filtered.length : total;

    res.json({
      data: pagedOf,
      page,
      pageSize,
      total: billTotal,
      totalPages: Math.max(1, Math.ceil(billTotal / pageSize)),
    });
  })
);

/**
 * Goods receipts across every purchase order — the inbound mirror of
 * GET /sales-orders/shipments. Posting one is what creates the FIFO cost
 * layers, so `totalCostCents` here is landed cost, not order value.
 */
purchaseOrdersRouter.get(
  "/goods-receipts",
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = pagination(req.query as Record<string, unknown>);
    const warehouseId = Number(req.query.warehouseId) || undefined;
    const search = String(req.query.search ?? "").trim();

    const where = {
      ...(warehouseId ? { warehouseId } : {}),
      ...(search
        ? {
            OR: [
              { grnNumber: contains(search) },
              { purchaseOrder: { poNumber: contains(search) } },
              { purchaseOrder: { supplierName: contains(search) } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.goodsReceipt.count({ where }),
      prisma.goodsReceipt.findMany({
        where,
        skip,
        take,
        orderBy: { receivedAt: "desc" },
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          purchaseOrder: {
            select: {
              id: true,
              poNumber: true,
              supplierName: true,
              status: true,
              // Coverage, so a row can say whether its order is still short.
              lines: { select: { quantity: true, receivedQty: true } },
            },
          },
        },
      }),
    ]);

    res.json({
      // A receipt is a historical document, but the useful question on this
      // page is "is that order still short?" — so each row carries its order's
      // CURRENT coverage rather than a frozen status that always read POSTED.
      data: rows.map(({ purchaseOrder, ...grn }) => {
        const ordered = purchaseOrder.lines.reduce((sum, l) => sum + l.quantity, 0);
        const received = purchaseOrder.lines.reduce((sum, l) => sum + l.receivedQty, 0);
        const { lines: _lines, ...order } = purchaseOrder;
        return {
          ...grn,
          purchaseOrder: order,
          orderQuantity: ordered,
          orderReceivedQty: received,
          orderComplete: received >= ordered,
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
 * A goods receipt note as a PDF — what gets signed on the dock and filed
 * against the vendor's delivery note.
 *
 * Carries landed cost, unlike the outbound packing slip which deliberately
 * carries none: this document faces inward, and the person checking it in is
 * the person who needs to know what it cost.
 */
purchaseOrdersRouter.get(
  "/goods-receipts/:grnId/note.pdf",
  asyncHandler(async (req, res) => {
    const grnId = intParam(req.params.grnId, "grnId");
    const grn = await prisma.goodsReceipt.findUnique({
      where: { id: grnId },
      include: {
        warehouse: true,
        purchaseOrder: {
          include: {
            vendor: true,
            lines: { include: { product: true, warehouse: true } },
          },
        },
      },
    });
    if (!grn) throw notFound("Goods receipt not found");
    renderGoodsReceipt(res, grn, companyDetails());
  })
);

purchaseOrdersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const order = await prisma.purchaseOrder.findUnique({ where: { id }, include });
    if (!order) throw notFound("Purchase order not found");
    res.json({ ...order, totalQuantity: order.lines.reduce((s, l) => s + l.quantity, 0) });
  })
);

/** SAVED: appears on reports as incoming inventory. No ledger effect yet. */
purchaseOrdersRouter.post(
  "/",
  requireStock,
  asyncHandler(async (req, res) => {
    const body = parseBody(createSchema, req.body);

    const order = await prisma.$transaction(async (tx) => {
      await assertReferencesUsable(tx, body.lines);

      let supplierName = body.supplierName?.trim() ?? "";
      if (body.vendorId) {
        const vendor = await tx.vendor.findUnique({ where: { id: body.vendorId } });
        if (!vendor) throw notFound(`Vendor ${body.vendorId} not found`);
        if (!vendor.isActive) throw badRequest(`Vendor ${vendor.name} is archived`);
        supplierName = vendor.name;
      }
      if (!supplierName) throw badRequest("A purchase order needs a vendor");

      const products = await tx.product.findMany({
        where: { id: { in: body.lines.map((l) => l.productId) } },
      });
      const costOf = (productId: number, given?: number) =>
        given ?? products.find((p) => p.id === productId)?.defaultCostCents ?? 0;

      const lines = body.lines.map((l) => {
        const unitCostCents = costOf(l.productId, l.unitCostCents);
        return {
          productId: l.productId,
          warehouseId: l.warehouseId,
          quantity: l.quantity,
          unitCostCents,
          lineTotalCents: unitCostCents * l.quantity,
          status: "PENDING",
        };
      });

      const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const taxCents = body.taxCents ?? 0;
      const shippingCents = body.shippingCents ?? 0;

      const created = await tx.purchaseOrder.create({
        data: {
          poNumber: await nextPurchaseOrderNumber(tx),
          vendorId: body.vendorId ?? null,
          supplierName,
          employeeId: body.employeeId ?? null,
          notes: body.notes ?? null,
          status: "SAVED",
          subtotalCents,
          taxCents,
          shippingCents,
          totalCents: subtotalCents + taxCents + shippingCents,
          lines: { create: lines },
        },
        include,
      });

      // A saved PO already counts as incoming stock, per the scope.
      for (const line of created.lines) {
        await applyBalanceDelta(
          tx,
          line.productId,
          line.warehouseId,
          { incomingQty: line.quantity },
          `Cannot book incoming stock for ${line.product.sku}`
        );
      }

      return tx.purchaseOrder.findUniqueOrThrow({ where: { id: created.id }, include });
    });

    res.status(201).json(order);
  })
);

/** POSTED creates the Vendor Bill: Dr Prepaid Inventory, Cr Accounts Payable. */
purchaseOrdersRouter.post(
  "/:id/post",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      if (current.status !== "SAVED") {
        throw conflict(`Only a saved purchase order can be posted (this one is ${current.status})`);
      }
      if (!current.vendorId) {
        throw badRequest("A vendor bill needs a vendor from the catalog, not just a name");
      }
      if (current.totalCents <= 0) {
        throw badRequest("Cannot post a purchase order with no value — set unit costs on its lines");
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: "SAVED" },
        data: { status: "POSTED" },
      });
      if (claimed.count === 0) throw conflict("This purchase order was already posted");

      const bill = await tx.bill.create({
        data: {
          billNumber: await nextBillNumber(tx),
          purchaseOrderId: current.id,
          vendorId: current.vendorId,
          subtotalCents: current.subtotalCents,
          taxCents: current.taxCents,
          shippingCents: current.shippingCents,
          totalCents: current.totalCents,
          status: "POSTED",
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.PURCHASE_BILL,
        amountCents: current.totalCents,
        memo: `Bill ${bill.billNumber} for ${current.poNumber}`,
        referenceType: "BILL",
        referenceId: bill.id,
        actor,
      });

      await tx.purchaseOrderLine.updateMany({
        where: { purchaseOrderId: id },
        data: { status: "ORDERED" },
      });

      return { bill, entry, order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include }) };
    });

    res.status(201).json(result);
  })
);

/** PAID: Dr Accounts Payable, Cr Bank. */
purchaseOrdersRouter.post(
  "/:id/pay",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const body = parseBody(payBillSchema, req.body ?? {});
    const method = body.method ?? "BANK";

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      // A vendor may deliver before being paid, so DELIVERED is payable too.
      // Paying a delivered order must not walk its status backwards.
      if (current.status !== "POSTED" && current.status !== "DELIVERED") {
        throw conflict(`Only a posted or delivered purchase order can be paid (this one is ${current.status})`);
      }
      const bill = current.bills.find((b) => b.status === "POSTED");
      if (!bill) throw badRequest("No posted bill found for this purchase order");
      // Counting payments was the old gate, and it closed the bill after the
      // first one — so a deposit plus a balance, which is how capital equipment
      // is actually bought, could not be recorded. Sum the money instead.
      // Lock before reading; see payments.ts for what goes wrong without it.
      await lockDocumentForPayment(tx, "Bill", bill.id);
      const alreadyPaidCents = await paidAgainst(tx, { billId: bill.id });
      const outstandingCents = bill.totalCents - alreadyPaidCents;
      if (outstandingCents <= 0) throw conflict("This bill has already been paid in full");

      const amountCents = body.amountCents ?? outstandingCents;
      if (amountCents <= 0) throw badRequest("A payment has to be for a positive amount");
      if (amountCents > outstandingCents) {
        // Overpaying a vendor creates a debit balance with them, which is a
        // real event with its own accounting — not something to fake here.
        throw badRequest(
          `That is more than is owed: ${outstandingCents} remains on ${bill.billNumber}`
        );
      }

      const settles = amountCents === outstandingCents;
      if (settles) {
        const claimed = await tx.purchaseOrder.updateMany({
          where: { id, status: current.status },
          // A delivered order stays delivered; only a posted one advances to PAID.
          data: { status: current.status === "POSTED" ? "PAID" : "DELIVERED" },
        });
        if (claimed.count === 0) throw conflict("This purchase order was already changed");
      }

      const payment = await tx.payment.create({
        data: {
          paymentNumber: await nextPaymentNumber(tx),
          direction: "DISBURSEMENT",
          amountCents,
          method,
          status: "POSTED",
          billId: bill.id,
          vendorId: current.vendorId,
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.PURCHASE_PAYMENT,
        amountCents,
        memo: settles
          ? `Payment ${payment.paymentNumber} against ${bill.billNumber}`
          : `Part payment ${payment.paymentNumber} against ${bill.billNumber} (${amountCents} of ${bill.totalCents})`,
        referenceType: "PAYMENT",
        referenceId: payment.id,
        actor,
      });

      return {
        payment,
        entry,
        outstandingCents: outstandingCents - amountCents,
        order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.status(201).json(result);
  })
);

/**
 * DELIVERED creates the GRN, the FIFO cost layers, and posts
 * Dr Inventory / Cr Prepaid Inventory.
 *
 * This is the only place stock acquires a cost from a purchase, which is why
 * the layers are created here and not when the PO was posted.
 */
/**
 * REVERSE A PAYMENT — an error correction, not a refund. See the matching
 * route on sales orders for why those are deliberately different verbs.
 */
purchaseOrdersRouter.post(
  "/:id/reverse-payment",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const body = parseBody(reversePaymentSchema, req.body ?? {});
    const reason = body.reason;

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");

      const billIds = current.bills.map((b) => b.id);
      // Targetable by id, as on the sales side. Without it a bookkeeper who
      // mis-keys a deposit and then correctly pays the balance can only ever
      // reverse the balance — the endpoint returns 200 having undone the
      // wrong instalment, and the mis-keyed one is stuck for good.
      const payment = body.paymentId
        ? await tx.payment.findFirst({
            where: { id: body.paymentId, billId: { in: billIds }, status: { not: "VOID" } },
          })
        : await tx.payment.findFirst({
            where: { billId: { in: billIds }, status: { not: "VOID" } },
            orderBy: { id: "desc" },
          });
      if (!payment) {
        throw conflict(
          body.paymentId
            ? `Payment ${body.paymentId} is not a live payment on this purchase order`
            : "There is no live payment on this purchase order to reverse"
        );
      }

      // PAID walks back to POSTED. A DELIVERED order stays delivered: the goods
      // arrived regardless of what happened to the money.
      if (current.status === "PAID") {
        const claimed = await tx.purchaseOrder.updateMany({
          where: { id, status: "PAID" },
          data: { status: "POSTED" },
        });
        if (claimed.count === 0) throw conflict("This purchase order was already changed");
      }

      // Atomic claim, same as the sales side: two concurrent reversals must not
      // both post (Postgres does not serialise them the way SQLite does).
      const voided = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: "VOID" } },
        data: { status: "VOID" },
      });
      if (voided.count === 0) throw conflict(`Payment ${payment.paymentNumber} was already reversed`);

      const reversal = await reverseDocumentEntry(tx, "PAYMENT", payment.id, {
        actor,
        memo: `Payment ${payment.paymentNumber} reversed: ${reason}`,
      });

      return {
        payment: await tx.payment.findUniqueOrThrow({ where: { id: payment.id } }),
        reversal,
        order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.json(result);
  })
);

purchaseOrdersRouter.post(
  "/:id/receive",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const body = parseBody(receiveSchema, req.body ?? {});

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");

      /**
       * What is arriving THIS time. Suppliers under-ship and back-order, so a
       * receipt is per line and per quantity. Omitting the body receives
       * everything still outstanding, which is what the all-or-nothing
       * version did.
       */
      const requested = new Map<number, number>();
      if (body.lines) {
        for (const ask of body.lines) {
          const line = current.lines.find((l) => l.id === ask.lineId);
          if (!line) throw badRequest(`Line ${ask.lineId} is not on ${current.poNumber}`);
          if (requested.has(ask.lineId)) throw badRequest(`Line ${ask.lineId} appears twice`);
          if (ask.quantity > 0) requested.set(ask.lineId, ask.quantity);
        }
      } else {
        for (const line of current.lines) {
          const outstanding = outstandingOf(line);
          if (outstanding > 0) requested.set(line.id, outstanding);
        }
      }

      // A serial-tracked product needs one cost layer PER UNIT with its serial on it
      // (serials.ts). Received here in bulk it would get one multi-unit layer and no
      // serials, and the first shipment would fail to find a unit to sell. Serialised
      // lines are received box by box through /receive, which records each serial.
      const serialLines = current.lines.filter(
        (l) => requested.has(l.id) && l.product.trackingMode === "SERIAL"
      );
      if (serialLines.length > 0) {
        throw badRequest(
          `${serialLines.map((l) => l.product.sku).join(", ")} ${serialLines.length === 1 ? "is" : "are"} serial-tracked — receive ${serialLines.length === 1 ? "it" : "them"} on the Receive screen so each unit's serial is recorded`,
          { action: "receive-serials", lineIds: serialLines.map((l) => l.id) }
        );
      }

      const receipt = await receiveAgainstOrder(tx, { order: current, requested, actor });
      return {
        ...receipt,
        order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include }),
      };
    });

    res.json(result);
  })
);

/**
 * Void a posted bill by reversing its journal entry, returning the order to
 * SAVED so it can be corrected or cancelled.
 */
purchaseOrdersRouter.post(
  "/:id/void-bill",
  requireMoney,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      if (current.status === "PAID") {
        throw conflict("Void the payment before voiding the bill");
      }
      if (current.status === "DELIVERED") {
        throw conflict("These goods have been received — the bill cannot be voided");
      }
      /*
       * DELIVERED is no longer the only state holding stock. A PART received
       * order stays POSTED, and this guard used to let it through: the bill
       * was voided and its entry reversed (Cr Prepaid Inventory) while the
       * goods receipts that had ALREADY credited Prepaid stayed live, crediting
       * it twice and driving it negative, with received lines reset to PENDING
       * behind stock that is physically on the shelf.
       */
      const received =
        current.goodsReceipts.length > 0 || current.lines.some((l) => l.receivedQty > 0);
      if (received) {
        throw conflict(
          "Goods have already been received against this order — the bill cannot be voided"
        );
      }
      // Same reasoning as the sales side: a part paid bill sits at POSTED.
      const livePayments = await tx.payment.count({
        where: { billId: { in: current.bills.map((b) => b.id) }, status: { not: "VOID" } },
      });
      if (livePayments > 0) {
        throw conflict(
          "There is a payment recorded against this bill — reverse it before voiding"
        );
      }
      if (current.status !== "POSTED") {
        throw conflict(`There is no posted bill to void (order is ${current.status})`);
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: "POSTED" },
        data: { status: "SAVED" },
      });
      if (claimed.count === 0) throw conflict("This purchase order was already changed");

      const bill = current.bills.find((b) => b.status === "POSTED");
      if (bill) {
        await tx.bill.update({ where: { id: bill.id }, data: { status: "VOID" } });
        await reverseDocumentEntry(tx, "BILL", bill.id, {
          actor,
          memo: `Void ${bill.billNumber}`,
        });
      }
      await tx.purchaseOrderLine.updateMany({
        where: { purchaseOrderId: id },
        data: { status: "PENDING" },
      });

      return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(result);
  })
);

purchaseOrdersRouter.post(
  "/:id/cancel",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    const order = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      if (current.status === "DELIVERED") throw conflict("A delivered purchase order cannot be canceled");
      if (current.status === "CANCELED") throw conflict("Purchase order is already canceled");
      if (current.status === "PAID") {
        const live = await tx.payment.findFirst({
          where: { billId: { in: current.bills.map((b) => b.id) }, status: { not: "VOID" } },
          orderBy: { id: "desc" },
        });
        throw conflict(
          live
            ? `This purchase order is paid by ${live.paymentNumber}. Reverse that payment first, then cancel.`
            : "This purchase order is paid — reverse the payment before canceling",
          live ? { action: "reverse-payment", purchaseOrderId: current.id, paymentNumber: live.paymentNumber } : undefined
        );
      }
      // A posted order has a bill on the books: Prepaid Inventory and Accounts
      // Payable are both standing. Cancelling around it strands them.
      if (current.status === "POSTED") {
        throw conflict("This purchase order has a posted bill — void the bill first");
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: current.status },
        data: { status: "CANCELED" },
      });
      if (claimed.count === 0) throw conflict("This purchase order was already changed");

      // Incoming stock was booked at save time, so it is always released.
      for (const line of current.lines) {
        await applyBalanceDelta(
          tx,
          line.productId,
          line.warehouseId,
          { incomingQty: -line.quantity },
          `Cannot release incoming stock for ${line.product.sku}`
        );
      }

      await tx.purchaseOrderLine.updateMany({ where: { purchaseOrderId: id }, data: { status: "CANCELED" } });
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include });
    });

    res.json(order);
  })
);

purchaseOrdersRouter.delete(
  "/:id",
  requireStock,
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { lines: true, bills: true, goodsReceipts: true },
      });
      if (!current) throw notFound("Purchase order not found");
      if (current.bills.length > 0 || current.goodsReceipts.length > 0) {
        throw badRequest("This purchase order has posted documents and cannot be deleted");
      }
      if (current.status === "SAVED") {
        // Give back the incoming quantity this PO was holding.
        for (const line of current.lines) {
          await applyBalanceDelta(
            tx,
            line.productId,
            line.warehouseId,
            { incomingQty: -line.quantity },
            "Cannot release incoming stock"
          );
        }
      }
      await tx.purchaseOrder.delete({ where: { id } });
    });

    res.json({ deleted: true });
  })
);
