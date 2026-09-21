import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { requireMoney, requireStock } from "../auth";
import { applyBalanceDelta, recordMovement } from "../inventory";
import { createLot } from "../costing";
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

const payBillSchema = z.object({
  /// Omitted means "settle what is left", which is what every caller meant
  /// before this field existed.
  amountCents: z.number().int().optional(),
  method: z.string().optional(),
});

/** Money actually paid against a bill: live payments only, always summed fresh. */
async function paidAgainstBill(tx: { payment: { findMany: Function } }, billId: number) {
  const payments = await tx.payment.findMany({
    where: { billId, status: { not: "VOID" } },
    select: { amountCents: true },
  });
  return payments.reduce((sum: number, p: { amountCents: number }) => sum + p.amountCents, 0);
}

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
        skip,
        take,
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
    const filtered =
      settlement === "PAID"
        ? mapped.filter((b) => b.status !== "VOID" && b.outstandingCents === 0)
        : settlement === "UNPAID"
          ? mapped.filter((b) => b.status !== "VOID" && b.outstandingCents > 0)
          : mapped;

    res.json({
      data: filtered,
      page,
      pageSize,
      total: settlement ? filtered.length : total,
      totalPages: Math.max(1, Math.ceil((settlement ? filtered.length : total) / pageSize)),
      partialFilter: Boolean(settlement),
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
            select: { id: true, poNumber: true, supplierName: true, status: true },
          },
        },
      }),
    ]);

    res.json({
      data: rows,
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
      const alreadyPaidCents = await paidAgainstBill(tx, bill.id);
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
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw badRequest("A reason is required — this reverses money already recorded");

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");

      const billIds = current.bills.map((b) => b.id);
      const payment = await tx.payment.findFirst({
        where: { billId: { in: billIds }, status: { not: "VOID" } },
        orderBy: { id: "desc" },
      });
      if (!payment) throw conflict("There is no live payment on this purchase order to reverse");

      // PAID walks back to POSTED. A DELIVERED order stays delivered: the goods
      // arrived regardless of what happened to the money.
      if (current.status === "PAID") {
        const claimed = await tx.purchaseOrder.updateMany({
          where: { id, status: "PAID" },
          data: { status: "POSTED" },
        });
        if (claimed.count === 0) throw conflict("This purchase order was already changed");
      }

      await tx.payment.update({ where: { id: payment.id }, data: { status: "VOID" } });

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

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      // The scope's lifecycle is Saved -> Posted -> Paid -> Delivered, but a
      // vendor can deliver before being paid, so both are accepted here.
      if (current.status !== "POSTED" && current.status !== "PAID") {
        throw conflict(
          `Only a posted or paid purchase order can be received (this one is ${current.status})`
        );
      }

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: current.status },
        data: { status: "DELIVERED" },
      });
      if (claimed.count === 0) throw conflict("This purchase order was already received");

      // Only named when the whole receipt lands in one warehouse.
      const warehouseIds = new Set(current.lines.map((l) => l.warehouseId));
      const warehouseId = warehouseIds.size === 1 ? current.lines[0].warehouseId : null;
      const grn = await tx.goodsReceipt.create({
        data: {
          grnNumber: await nextGrnNumber(tx),
          purchaseOrderId: current.id,
          warehouseId,
          status: "POSTED",
        },
      });

      // The bill debited Prepaid Inventory for the WHOLE invoice, tax and
      // shipping included. If the receipt only clears the goods value, the
      // difference sits in Prepaid Inventory forever. Landed cost is the
      // honest treatment: spread the extras across the lines by value, so
      // what leaves Prepaid equals what went in.
      const goodsCents = current.lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const extrasCents = current.taxCents + current.shippingCents;

      let totalCostCents = 0;
      let extrasAllocated = 0;
      for (const [index, line] of current.lines.entries()) {
        await applyBalanceDelta(
          tx,
          line.productId,
          line.warehouseId,
          { incomingQty: -line.quantity, onHandQty: line.quantity },
          `Cannot receive ${line.product.sku}`
        );

        // Allocate the extras by line value, giving the last line whatever
        // remains so the parts always sum to the whole — no lost cents.
        const isLast = index === current.lines.length - 1;
        const lineExtras = isLast
          ? extrasCents - extrasAllocated
          : goodsCents > 0
            ? Math.round((extrasCents * line.lineTotalCents) / goodsCents)
            : 0;
        extrasAllocated += lineExtras;

        const lineCost = line.lineTotalCents + lineExtras;
        // Landed unit cost, rounded to the cent; the layer's total is the
        // authority, so the remainder rides on the line rather than vanishing.
        const landedUnitCost = Math.round(lineCost / line.quantity);

        await createLot(tx, {
          productId: line.productId,
          warehouseId: line.warehouseId,
          quantity: line.quantity,
          unitCostCents: landedUnitCost,
          sourceType: "GOODS_RECEIPT",
          sourceId: grn.id,
        });

        totalCostCents += landedUnitCost * line.quantity;

        await recordMovement(tx, {
          productId: line.productId,
          toWarehouseId: line.warehouseId,
          quantity: line.quantity,
          movementType: "PURCHASE_RECEIPT",
          reason: `Received on ${grn.grnNumber} (${current.poNumber})`,
          referenceType: "GOODS_RECEIPT",
          referenceId: grn.id,
          totalCostCents: lineCost,
          actor,
        });
        await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { status: "RECEIVED" } });
      }

      await tx.goodsReceipt.update({ where: { id: grn.id }, data: { totalCostCents } });

      /**
       * The bill debited Prepaid Inventory for the vendor's exact total. The
       * cost layers hold `landedUnitCost * quantity`, which cannot always equal
       * that total — a unit cost is a whole number of cents, so any line whose
       * cost does not divide evenly by its quantity leaves a residue.
       *
       * Posting only the layer value would strand that residue in Prepaid
       * forever; posting only the bill value would break the reconciliation
       * between the layers and the Inventory account. So the entry carries
       * three lines: Inventory gets exactly what the layers are worth, Prepaid
       * is cleared by exactly what the bill put there, and the difference is
       * named as a rounding variance rather than hidden in either.
       */
      const varianceCents = current.totalCents - totalCostCents;
      const lines: DraftLine[] = [
        {
          accountCode: ACCOUNT.INVENTORY,
          debitCents: totalCostCents,
          memo: "Value of the cost layers created",
        },
        {
          accountCode: ACCOUNT.PREPAID_INVENTORY,
          creditCents: current.totalCents,
          memo: `Clears ${current.poNumber}`,
        },
      ];
      if (varianceCents > 0) {
        lines.push({
          accountCode: ACCOUNT.ROUNDING_VARIANCE,
          debitCents: varianceCents,
          memo: "Landed cost rounding",
        });
      } else if (varianceCents < 0) {
        lines.push({
          accountCode: ACCOUNT.ROUNDING_VARIANCE,
          creditCents: -varianceCents,
          memo: "Landed cost rounding",
        });
      }

      const entry = await createEntry(tx, {
        transactionType: TRANSACTION_TYPE.GOODS_RECEIPT,
        lines,
        memo: `Goods receipt ${grn.grnNumber} for ${current.poNumber}`,
        referenceType: "GOODS_RECEIPT",
        referenceId: grn.id,
        actor,
      });

      return {
        goodsReceipt: { ...grn, totalCostCents },
        entry,
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
