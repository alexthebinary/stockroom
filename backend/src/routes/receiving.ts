/**
 * The clerk's receiving flow — one endpoint per physical action.
 *
 * Built for an operator with a phone and no time. Every call does the most it
 * safely can on its own and answers with what HAPPENED, so the UI is a feed
 * rather than a form.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, notFound } from "../errors";
import { actorOf, asyncHandler, intParam, parseBody } from "../http";
import { requireStock } from "../auth";
import { receiveAgainstOrder } from "../goods_receipt";
import { receiveSerials } from "../serials";
import { adjudicate, type Reader } from "../vision_adjudicate";
import { readLabel, visionConfigured } from "../vision";
import { makeClient, pushAvailability, shopifyConfig, SHOPIFY_API_VERSION } from "../shopify";
import { ShopifySim, shopifyMode } from "../shopify_sim";

export const receivingRouter = Router();

/** What is expected at a warehouse today: posted POs with stock still to come. */
receivingRouter.get(
  "/receiving/expected",
  asyncHandler(async (req, res) => {
    const warehouseId = req.query.warehouseId ? intParam(req.query.warehouseId, "warehouseId") : null;
    const orders = await prisma.purchaseOrder.findMany({
      where: {
        status: { in: ["POSTED", "PAID"] },
        ...(warehouseId ? { lines: { some: { warehouseId } } } : {}),
      },
      include: {
        vendor: true,
        lines: { include: { product: true, warehouse: true } },
        goodsReceipts: true,
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    res.json(
      orders.map((po) => {
        const lines = warehouseId ? po.lines.filter((l) => l.warehouseId === warehouseId) : po.lines;
        const ordered = lines.reduce((s, l) => s + l.quantity, 0);
        const received = lines.reduce((s, l) => s + l.receivedQty, 0);
        return {
          id: po.id,
          poNumber: po.poNumber,
          vendor: po.vendor?.name ?? po.supplierName,
          status: po.status,
          ordered,
          received,
          outstanding: ordered - received,
          lines: lines.map((l) => ({
            id: l.id,
            sku: l.product.sku,
            name: l.product.name,
            brand: l.product.brand,
            serialized: l.product.trackingMode === "SERIAL",
            warehouseId: l.warehouseId,
            warehouse: l.warehouse.code,
            quantity: l.quantity,
            receivedQty: l.receivedQty,
            outstanding: l.quantity - l.receivedQty,
          })),
        };
      })
    );
  })
);

const scanSchema = z.object({
  purchaseOrderLineId: z.number().int().positive(),
  /** One reader per model or device. Family is what makes agreement meaningful. */
  readers: z
    .array(
      z.object({
        id: z.string().min(1),
        family: z.string().min(1),
        text: z.string().nullable(),
        confidence: z.number().min(0).max(1).nullable().optional(),
      })
    )
    .default([]),
  barcode: z.string().trim().min(1).optional(),
  /** A JPEG data URL straight from the camera. Read server-side by two models. */
  image: z.string().startsWith("data:image/").optional(),
  attempt: z.number().int().min(1).max(10).default(1),
  labelImageKey: z.string().optional(),
});

/**
 * Scan one package against a PO line.
 *
 * Commits whatever it can work out and tells the UI what it did. The only
 * outcome that stops is a label no reader could read — and that asks for
 * another photo before it asks for a person.
 */
receivingRouter.post(
  "/receiving/scan",
  requireStock,
  asyncHandler(async (req, res) => {
    const body = parseBody(scanSchema, req.body);
    const actor = actorOf(req);

    // Read OUTSIDE the transaction only to decide whether to spend money on
    // vision models. The authoritative read — and the over-receive check that
    // depends on it — happens inside, because the adjudication below can take
    // seconds and two scanners on one pallet must not both pass a stale check.
    const line = await prisma.purchaseOrderLine.findUnique({
      where: { id: body.purchaseOrderLineId },
      include: { product: true, purchaseOrder: true },
    });
    if (!line) throw notFound("Purchase order line not found");
    if (line.receivedQty >= line.quantity) {
      throw badRequest(
        `${line.product.sku}: all ${line.quantity} already received on ${line.purchaseOrder.poNumber}`,
        { action: "line-complete", lineId: line.id }
      );
    }

    // Readers may arrive from the device (on-device OCR) and/or be produced
    // here from the photo. Both feed the same ladder.
    const fromModels = body.image ? await readLabel(body.image) : [];
    const readers = [...((body.readers ?? []) as Reader[]), ...fromModels];

    const verdict = adjudicate({
      brand: line.product.brand,
      barcode: body.barcode ?? null,
      readers,
      attempt: body.attempt,
    });

    if (verdict.retry || verdict.escalate) {
      return res.status(200).json({
        outcome: verdict.retry ? "retry" : "escalate",
        message: verdict.reviewReason,
        attempt: body.attempt,
        evidence: verdict.evidence,
      });
    }

    const serialized = line.product.trackingMode === "SERIAL";

    /**
     * One box, through the SAME pipeline the manual receive uses.
     *
     * This used to increment onHandQty and receivedQty and stop: no incoming
     * decrement, no goods receipt, no movement, no cost layer for
     * non-serialised goods, and no journal entry. Stock appeared on the shelf
     * that the books knew nothing about, and it had no FIFO layer to consume
     * when it later shipped.
     */
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: line.purchaseOrderId },
        include: { lines: { include: { product: true } } },
      });

      const receipt = await receiveAgainstOrder(tx, {
        order,
        requested: new Map([[line.id, 1]]),
        actor,
      });

      if (serialized) {
        // The unit belongs to the layer this receipt just created, so its
        // provenance points at the same document as the stock it is part of.
        const lotId = receipt.createdLots.find((l) => l.lineId === line.id)?.lotId ?? null;
        const [unit] = await receiveSerials(tx, {
          productId: line.productId,
          warehouseId: line.warehouseId,
          unitCostCents: line.unitCostCents,
          serials: [{ serialNumber: verdict.serial, boxSerial: body.barcode ?? null }],
          warrantyStartAt: new Date(),
          sourceType: "GOODS_RECEIPT",
          sourceId: receipt.goodsReceipt.id,
          lotId,
        });
        await tx.serialUnit.update({
          where: { id: unit.id },
          data: {
            serialSource: verdict.source,
            ocrConfidence: readers[0]?.confidence ?? null,
            labelImageKey: body.labelImageKey ?? null,
            needsReview: verdict.needsReview,
            reviewReason: verdict.reviewReason,
          },
        });
      }

      return {
        line: await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id } }),
        goodsReceipt: receipt.goodsReceipt,
        complete: receipt.complete,
      };
    });

    res.json({
      outcome: "received",
      serial: serialized ? verdict.serial : null,
      source: verdict.source,
      agreement: verdict.agreement,
      evidence: verdict.evidence,
      flagged: verdict.needsReview,
      flagReason: verdict.reviewReason,
      goodsReceipt: result.goodsReceipt.grnNumber,
      orderComplete: result.complete,
      line: {
        id: result.line.id,
        sku: line.product.sku,
        receivedQty: result.line.receivedQty,
        quantity: result.line.quantity,
        outstanding: result.line.quantity - result.line.receivedQty,
      },
      actor,
    });
  })
);

/** Everything the software committed but wants an eye on. The exception feed. */
receivingRouter.get(
  "/receiving/attention",
  asyncHandler(async (_req, res) => {
    const flagged = await prisma.serialUnit.findMany({
      where: { needsReview: true },
      include: { product: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(
      flagged.map((u) => ({
        id: u.id,
        serialNumber: u.serialNumber,
        sku: u.product.sku,
        name: u.product.name,
        brand: u.product.brand,
        reason: u.reviewReason,
        source: u.serialSource,
        confidence: u.ocrConfidence,
        at: u.createdAt,
      }))
    );
  })
);

/** Is a second opinion actually wired? The UI says so rather than pretending. */
receivingRouter.get(
  "/receiving/capabilities",
  asyncHandler(async (_req, res) => {
    res.json({ visionReaders: visionConfigured() });
  })
);

/**
 * Publish a product's availability to Shopify.
 *
 * ⚠️ Deliberately its own call, OUTSIDE any transaction. SQLite serialises
 * writers, so holding a transaction open across a network round trip to Shopify
 * would stall every other write in the app. Receiving books the stock and the
 * ledger first; publishing is a separate, retryable step.
 */
/**
 * The simulated store, shared across requests so a demo can push, "sell" and
 * push again and watch compare-and-set refuse the stale number.
 * Process-local on purpose — a simulator that persisted would be a second
 * source of truth nobody asked for.
 */
const sim = new ShopifySim();

receivingRouter.post(
  "/shopify/push",
  requireStock,
  asyncHandler(async (req, res) => {
    const { mode, reason } = shopifyMode();
    const productId = intParam(req.body?.productId, "productId");
    const warehouseId = intParam(req.body?.warehouseId, "warehouseId");

    const cfg = shopifyConfig();
    const client = mode === "live" ? makeClient(cfg!) : sim.client();
    const buffer = cfg?.buffer ?? Number(process.env.SHOPIFY_SAFETY_BUFFER ?? 1);

    const outcome = await pushAvailability(prisma, client, { productId, warehouseId, buffer });
    // Every response says which store it hit. A result that does not name its
    // mode is one somebody will eventually misread.
    res.json({ ...outcome, mode, modeReason: reason });
  })
);

/** Move the simulated store's number behind our back, like a customer would. */
receivingRouter.post(
  "/shopify/sim/sell",
  requireStock,
  asyncHandler(async (req, res) => {
    const { mode } = shopifyMode();
    if (mode === "live") throw badRequest("Refusing to fake a sale against a live store");
    const productId = intParam(req.body?.productId, "productId");
    const warehouseId = intParam(req.body?.warehouseId, "warehouseId");
    const link = await prisma.shopifyLink.findUnique({ where: { productId } });
    const loc = await prisma.shopifyLocation.findUnique({ where: { warehouseId } });
    if (!link || !loc) throw badRequest("Product or warehouse is not mapped to Shopify");
    sim.sellOne(link.inventoryItemId, loc.locationId, Number(req.body?.quantity ?? 1));
    res.json({
      mode: "sim",
      storefrontNow: sim.get(link.inventoryItemId, loc.locationId),
    });
  })
);

/** What mode are we in, and what does the simulated store currently hold? */
receivingRouter.get(
  "/shopify/status",
  asyncHandler(async (_req, res) => {
    const { mode, reason } = shopifyMode();
    res.json({ mode, reason, apiVersion: SHOPIFY_API_VERSION, simCalls: mode === "sim" ? sim.calls.length : null });
  })
);
