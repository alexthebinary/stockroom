import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { contains } from "../search";
import { badRequest, conflict, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, pagination, parseBody } from "../http";
import { applyBalanceDelta, recordMovement } from "../inventory";
import { createLot } from "../costing";
import { postSimple, reverseDocumentEntry } from "../ledger";
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
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");
    const actor = actorOf(req);
    const method = String(req.body?.method ?? "BANK");

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
      const alreadyPaid = await tx.payment.count({
        where: { billId: bill.id, status: "POSTED" },
      });
      if (alreadyPaid > 0) throw conflict("This bill has already been paid");

      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: current.status },
        // A delivered order stays delivered; only a posted one advances to PAID.
        data: { status: current.status === "POSTED" ? "PAID" : "DELIVERED" },
      });
      if (claimed.count === 0) throw conflict("This purchase order was already changed");

      const payment = await tx.payment.create({
        data: {
          paymentNumber: await nextPaymentNumber(tx),
          direction: "DISBURSEMENT",
          amountCents: bill.totalCents,
          method,
          status: "POSTED",
          billId: bill.id,
          vendorId: current.vendorId,
        },
      });

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.PURCHASE_PAYMENT,
        amountCents: bill.totalCents,
        memo: `Payment ${payment.paymentNumber} against ${bill.billNumber}`,
        referenceType: "PAYMENT",
        referenceId: payment.id,
        actor,
      });

      return { payment, entry, order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include }) };
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
purchaseOrdersRouter.post(
  "/:id/receive",
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

      const entry = await postSimple(tx, {
        transactionType: TRANSACTION_TYPE.GOODS_RECEIPT,
        amountCents: totalCostCents,
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
  asyncHandler(async (req, res) => {
    const id = intParam(req.params.id, "id");

    const order = await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findUnique({ where: { id }, include });
      if (!current) throw notFound("Purchase order not found");
      if (current.status === "DELIVERED") throw conflict("A delivered purchase order cannot be canceled");
      if (current.status === "CANCELED") throw conflict("Purchase order is already canceled");
      if (current.status === "PAID") {
        throw conflict("This purchase order is paid — void the payment before canceling");
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
