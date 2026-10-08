import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx, Prisma } from "../db";
import { actorOf, idParam, notFound, parse } from "../http";
import { dueDateFor, draftBillFromPo, postInventoryBill, previewBill, recomputeTotals } from "../purchasing/bills";
import { postFreightBill } from "../purchasing/freight";
import { createPo, refreshPoStatus } from "../purchasing/po";
import { receive } from "../purchasing/receive";
import { appendEvents, resolveUnknown, submitSession, tally } from "../purchasing/scan";

const poLine = z.object({ itemId: z.number().int().positive(), qtyOrdered: z.number().int().positive(), unitCostCents: z.number().int().min(0) });
const eventBody = z.object({
  clientId: z.string().min(8).max(64),
  code: z.string().max(200).nullish(),
  itemId: z.number().int().positive().nullish(),
  qty: z.number().int(),
  source: z.enum(["BARCODE", "AI", "MANUAL"]),
  serial: z.string().trim().max(80).nullish(),
  unknownName: z.string().trim().max(120).nullish(),
  photo: z.string().startsWith("data:image/").max(2_000_000).nullish(),
  capturedAt: z.coerce.date(),
}).refine((e) => e.qty !== 0 || e.unknownName || e.photo, "a scan counts at least one unit (a zero only carries a name or photo for an unknown box)");
const billPatch = z.object({
  version: z.number().int().min(0),
  vendorId: z.number().int().positive().nullish(),
  vendorInvoiceNumber: z.string().trim().max(60).nullish(),
  billDate: z.coerce.date().optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  dueDate: z.coerce.date().optional(),
  freightCents: z.number().int().min(0).optional(),
  allocationBasis: z.enum(["VALUE", "QTY"]).optional(),
  notes: z.string().max(2000).nullish(),
  attachment: z.string().startsWith("data:").max(8_000_000).nullish(),
  lines: z
    .array(z.object({ id: z.number().int().positive(), qty: z.number().int().min(0).default(0), unitCostCents: z.number().int().min(0).default(0), discountCents: z.number().int().min(0).default(0), amountCents: z.number().int().min(0).optional() }))
    .optional(),
  targetPoIds: z.array(z.number().int().positive()).optional(),
});

export function registerPurchasing(app: FastifyInstance, { db }: Deps) {
  // ── Purchase orders ──
  app.get("/api/purchase-orders", async (request) => {
    const q = parse(
      z.object({
        billingStatus: z.string().optional(),
        receivingStatus: z.string().optional(),
        paymentStatus: z.string().optional(),
        vendorId: z.coerce.number().int().optional(),
        search: z.string().optional(),
        lifecycle: z.string().default("OPEN"),
      }),
      request.query,
    );
    const orders = await db.purchaseOrder.findMany({
      where: {
        ...(q.lifecycle !== "ALL" ? { lifecycle: q.lifecycle } : {}),
        ...(q.billingStatus ? { billingStatus: q.billingStatus } : {}),
        ...(q.receivingStatus ? { receivingStatus: q.receivingStatus } : {}),
        ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
        ...(q.vendorId ? { vendorId: q.vendorId } : {}),
        ...(q.search ? { number: { contains: q.search, mode: "insensitive" as const } } : {}),
      },
      include: { lines: true },
      orderBy: { id: "desc" },
      take: 200,
    });
    const vendors = await db.vendor.findMany({ where: { id: { in: orders.map((o) => o.vendorId!).filter(Boolean) } } });
    return orders.map((o) => ({
      ...o,
      vendor: vendors.find((v) => v.id === o.vendorId) ?? null,
      heldUnits: o.lines.reduce((s, l) => s + l.qtyHeld, 0),
      totalEstimateCents: o.lines.reduce((s, l) => s + l.qtyOrdered * l.unitCostCents, 0),
    }));
  });

  app.get("/api/purchase-orders/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const po = await db.purchaseOrder.findUnique({ where: { id }, include: { lines: true, bills: { include: { lines: true } }, receipts: { include: { lines: true } } } });
    if (!po) throw notFound("Purchase order");
    const [vendor, items, warehouse] = await Promise.all([
      po.vendorId ? db.vendor.findUnique({ where: { id: po.vendorId } }) : null,
      db.item.findMany({ where: { id: { in: po.lines.map((l) => l.itemId) } } }),
      db.warehouse.findUnique({ where: { id: po.warehouseId } }),
    ]);
    return { ...po, vendor, warehouse, lines: po.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId) })) };
  });

  app.post("/api/purchase-orders", async (request) => {
    const body = parse(z.object({ vendorId: z.number().int().positive(), warehouseId: z.number().int().positive(), notes: z.string().optional(), lines: z.array(poLine).min(1) }), request.body);
    return inTx(db, async (tx) => {
      const po = await createPo(tx, { ...body, source: "MANUAL", actor: actorOf(request) });
      await audit(tx, actorOf(request), "po.created", "PurchaseOrder", po.id);
      return po;
    });
  });

  /** Edit while nothing is billed. Lines that have received stock can't drop below what arrived. */
  app.put("/api/purchase-orders/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ version: z.number().int(), vendorId: z.number().int().positive().nullish(), notes: z.string().nullish(), lines: z.array(poLine.extend({ id: z.number().int().positive().optional() })).optional() }),
      request.body,
    );
    return inTx(db, async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (po.version !== body.version) throw new DomainError(`${po.number} was changed by someone else. Reload it.`, 409);
      if (po.billingStatus === "BILLED") throw new DomainError(`${po.number} has a posted bill; change what was bought with a vendor credit instead`, 409);
      if (body.lines) {
        for (const existing of po.lines) {
          const next = body.lines.find((l) => l.id === existing.id);
          if (!next && existing.qtyReceived > 0) throw new DomainError(`A line that has received stock can't be removed`, 409);
          if (next && next.qtyOrdered < existing.qtyReceived) throw new DomainError(`A line can't be ordered below the ${existing.qtyReceived} already received`, 409);
          if (!next) await tx.purchaseOrderLine.delete({ where: { id: existing.id } });
          else await tx.purchaseOrderLine.update({ where: { id: existing.id }, data: { qtyOrdered: next.qtyOrdered, unitCostCents: next.unitCostCents } });
        }
        for (const added of body.lines.filter((l) => !l.id)) await tx.purchaseOrderLine.create({ data: { poId: id, itemId: added.itemId, qtyOrdered: added.qtyOrdered, unitCostCents: added.unitCostCents } });
      }
      await tx.purchaseOrder.update({ where: { id }, data: { vendorId: body.vendorId === undefined ? undefined : body.vendorId, notes: body.notes ?? undefined } });
      if (body.vendorId) await tx.vendorBill.updateMany({ where: { poId: id, status: "DRAFT", vendorId: null }, data: { vendorId: body.vendorId } });
      return refreshPoStatus(tx, id);
    });
  });

  app.post("/api/purchase-orders/:id/cancel", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true, bills: true } });
      if (po.lines.some((l) => l.qtyReceived > 0)) throw new DomainError(`${po.number} has received stock and can't be cancelled`, 409);
      if (po.bills.some((b) => b.status === "POSTED")) throw new DomainError(`${po.number} has a posted bill; void the bill first`, 409);
      await tx.vendorBill.updateMany({ where: { poId: id, status: "DRAFT" }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actorOf(request) } });
      await audit(tx, actorOf(request), "po.cancelled", "PurchaseOrder", id);
      return tx.purchaseOrder.update({ where: { id }, data: { lifecycle: "CANCELED" } });
    });
  });

  /** Receive by typing quantities (no camera), against this PO. */
  app.post("/api/purchase-orders/:id/receive", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ warehouseId: z.number().int().positive().optional(), items: z.array(z.object({ itemId: z.number().int().positive(), qty: z.number().int().positive(), serials: z.array(z.string().trim().min(1)).default([]) })).min(1) }),
      request.body,
    );
    return inTx(db, async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
      return receive({ tx, actor: actorOf(request) }, { warehouseId: body.warehouseId ?? po.warehouseId, vendorId: po.vendorId, poId: id, arrivals: body.items });
    });
  });

  /** What the dock is expecting: open orders with units still to arrive. */
  app.get("/api/receiving/expected", async (request) => {
    const { warehouseId, vendorId } = parse(z.object({ warehouseId: z.coerce.number().int().optional(), vendorId: z.coerce.number().int().optional() }), request.query);
    const orders = await db.purchaseOrder.findMany({
      where: { lifecycle: "OPEN", receivingStatus: { not: "RECEIVED" }, ...(warehouseId ? { warehouseId } : {}), ...(vendorId ? { vendorId } : {}) },
      include: { lines: true },
      orderBy: { id: "asc" },
    });
    const items = await db.item.findMany({ where: { id: { in: orders.flatMap((o) => o.lines.map((l) => l.itemId)) } } });
    const vendors = await db.vendor.findMany({ where: { id: { in: orders.map((o) => o.vendorId!).filter(Boolean) } } });
    return orders.map((o) => ({
      id: o.id,
      number: o.number,
      billingStatus: o.billingStatus,
      vendor: vendors.find((v) => v.id === o.vendorId) ?? null,
      lines: o.lines
        .filter((l) => l.qtyOrdered > l.qtyReceived)
        .map((l) => ({ id: l.id, itemId: l.itemId, item: items.find((i) => i.id === l.itemId), outstanding: l.qtyOrdered - l.qtyReceived })),
    }));
  });

  // ── Scan sessions (the clerk's "Receive delivery") ──
  app.post("/api/scan-sessions", async (request) => {
    const body = parse(
      z.object({ clientId: z.string().min(8).max(64), warehouseId: z.number().int().positive(), vendorId: z.number().int().positive().nullish(), poId: z.number().int().positive().nullish() }),
      request.body,
    );
    const existing = await db.scanSession.findUnique({ where: { clientId: body.clientId } });
    if (existing) return existing;
    return db.scanSession.create({ data: { ...body, startedBy: actorOf(request) } });
  });

  app.get("/api/scan-sessions", async (request) => {
    const { status } = parse(z.object({ status: z.string().default("OPEN") }), request.query);
    return db.scanSession.findMany({ where: { status }, orderBy: { id: "desc" }, take: 50, include: { _count: { select: { events: true } } } });
  });

  app.get("/api/scan-sessions/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const session = await db.scanSession.findUnique({ where: { id }, include: { events: { orderBy: { id: "asc" } } } });
    if (!session) throw notFound("Delivery");
    const counted = tally(session.events);
    const items = await db.item.findMany({ where: { id: { in: counted.items.map((i) => i.itemId) } } });
    return { ...session, tally: { ...counted, items: counted.items.map((i) => ({ ...i, item: items.find((x) => x.id === i.itemId) })) } };
  });

  app.patch("/api/scan-sessions/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ vendorId: z.number().int().positive().nullish(), poId: z.number().int().positive().nullish(), notes: z.string().max(2000).nullish(), slipRead: z.unknown().optional() }),
      request.body,
    );
    const updated = await db.scanSession.updateMany({
      where: { id, status: "OPEN" },
      data: { vendorId: body.vendorId, poId: body.poId, notes: body.notes, slipRead: body.slipRead === undefined ? undefined : (body.slipRead as Prisma.InputJsonValue) },
    });
    if (updated.count === 0) throw new DomainError("This delivery is already finished", 409);
    return db.scanSession.findUniqueOrThrow({ where: { id } });
  });

  app.post("/api/scan-sessions/:id/events", async (request) => {
    const { id } = parse(idParam, request.params);
    const { events } = parse(z.object({ events: z.array(eventBody).min(1).max(500) }), request.body);
    return inTx(db, (tx) => appendEvents(tx, id, events));
  });

  app.post("/api/scan-sessions/:id/submit", async (request) => {
    const { id } = parse(idParam, request.params);
    const { expectedEventCount } = parse(z.object({ expectedEventCount: z.number().int().min(0) }), request.body);
    return inTx(db, async (tx) => {
      const result = await submitSession({ tx, actor: actorOf(request) }, id, expectedEventCount);
      await audit(tx, actorOf(request), "delivery.submitted", "ScanSession", id, result);
      return result;
    });
  });

  app.post("/api/scan-sessions/:id/abandon", async (request) => {
    const { id } = parse(idParam, request.params);
    const updated = await db.scanSession.updateMany({ where: { id, status: "OPEN" }, data: { status: "ABANDONED" } });
    if (updated.count === 0) throw new DomainError("Only an unfinished delivery can be abandoned", 409);
    return { ok: true };
  });

  app.post("/api/scan-sessions/:id/resolve", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ code: z.string().nullable(), name: z.string().nullable().default(null), itemId: z.number().int().positive(), serials: z.array(z.string().trim().min(1)).default([]), learn: z.boolean().default(true) }),
      request.body,
    );
    return inTx(db, (tx) => resolveUnknown({ tx, actor: actorOf(request) }, id, body));
  });

  /** Unknown items from finished deliveries, for the bill desk's exceptions list. */
  app.get("/api/receiving/unknown", async () => {
    const sessions = await db.scanSession.findMany({ where: { status: "SUBMITTED" }, orderBy: { id: "desc" }, take: 200 });
    return sessions.flatMap((s) => {
      const result = s.result as { unknown?: { code: string | null; name: string | null; qty: number }[] } | null;
      return (result?.unknown ?? []).map((u) => ({ sessionId: s.id, submittedAt: s.submittedAt, startedBy: s.startedBy, ...u }));
    });
  });

  // ── Vendor bills ──
  app.get("/api/bills", async (request) => {
    const q = parse(z.object({ status: z.string().optional(), kind: z.string().optional(), vendorId: z.coerce.number().int().optional(), open: z.coerce.boolean().optional() }), request.query);
    const bills = await db.vendorBill.findMany({
      where: { ...(q.status ? { status: q.status } : { status: { not: "VOID" } }), ...(q.kind ? { kind: q.kind } : {}), ...(q.vendorId ? { vendorId: q.vendorId } : {}) },
      include: { lines: true, po: true },
      orderBy: [{ status: "asc" }, { id: "asc" }],
      take: 500,
    });
    const vendors = await db.vendor.findMany({ where: { id: { in: bills.map((b) => b.vendorId!).filter(Boolean) } } });
    const heldByPo = new Map<number, number>();
    for (const line of await db.purchaseOrderLine.findMany({ where: { poId: { in: bills.map((b) => b.poId!).filter(Boolean) }, qtyHeld: { gt: 0 } } })) {
      heldByPo.set(line.poId, (heldByPo.get(line.poId) ?? 0) + line.qtyHeld);
    }
    return bills
      .map((b) => ({
        ...b,
        attachment: b.attachment ? true : null,
        vendor: vendors.find((v) => v.id === b.vendorId) ?? null,
        heldUnits: b.poId ? (heldByPo.get(b.poId) ?? 0) : 0,
        openCents: b.status === "POSTED" ? b.totalCents - b.paidCents - b.creditedCents : 0,
      }))
      .filter((b) => !q.open || b.openCents !== 0);
  });

  app.get("/api/bills/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const bill = await db.vendorBill.findUnique({ where: { id }, include: { lines: true, allocations: true, po: { include: { lines: true } } } });
    if (!bill) throw notFound("Bill");
    const [vendor, items, payments, credits, preview] = await Promise.all([
      bill.vendorId ? db.vendor.findUnique({ where: { id: bill.vendorId } }) : null,
      db.item.findMany({ where: { id: { in: bill.lines.map((l) => l.itemId!).filter(Boolean) } } }),
      db.payment.findMany({ where: { billId: id }, orderBy: { id: "asc" } }),
      db.vendorCredit.findMany({ where: { billId: id }, include: { lines: true }, orderBy: { id: "asc" } }),
      bill.status === "DRAFT" ? inTx(db, (tx) => previewBill(tx, id)) : null,
    ]);
    return {
      ...bill,
      vendor,
      payments,
      credits,
      preview,
      openCents: bill.status === "POSTED" ? bill.totalCents - bill.paidCents - bill.creditedCents : 0,
      lines: bill.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId), poLine: bill.po?.lines.find((p) => p.id === l.poLineId) ?? null })),
    };
  });

  /** Accounting drafts a bill for a PO before the goods arrive (the WMS doc's PO → Bill → Receipt order). */
  app.post("/api/bills", async (request) => {
    const body = parse(z.object({ poId: z.number().int().positive() }), request.body);
    return inTx(db, async (tx) => {
      const bill = await draftBillFromPo(tx, body.poId);
      await refreshPoStatus(tx, body.poId);
      return bill;
    });
  });

  app.patch("/api/bills/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(billPatch, request.body);
    return inTx(db, async (tx) => {
      const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (bill.status !== "DRAFT") throw new DomainError(`${bill.number} is ${bill.status.toLowerCase()} and can't be edited`, 409);
      if (bill.version !== body.version) throw new DomainError(`${bill.number} was changed by someone else. Reload it.`, 409);
      const billDate = body.billDate ?? bill.billDate;
      const termsDays = body.termsDays ?? bill.termsDays;
      const vendorChanged = body.vendorId !== undefined && body.vendorId !== bill.vendorId;
      let terms = termsDays;
      if (vendorChanged && body.vendorId && body.termsDays === undefined) terms = (await tx.vendor.findUniqueOrThrow({ where: { id: body.vendorId } })).paymentTermsDays;
      await tx.vendorBill.update({
        where: { id },
        data: {
          vendorId: body.vendorId === undefined ? undefined : body.vendorId,
          vendorInvoiceNumber: body.vendorInvoiceNumber === undefined ? undefined : body.vendorInvoiceNumber,
          billDate,
          termsDays: terms,
          dueDate: body.dueDate ?? dueDateFor(billDate, terms),
          freightCents: body.freightCents,
          allocationBasis: body.allocationBasis,
          notes: body.notes === undefined ? undefined : body.notes,
          attachment: body.attachment === undefined ? undefined : body.attachment,
          targetPoIds: body.targetPoIds,
          version: { increment: 1 },
        },
      });
      for (const line of body.lines ?? []) {
        if (!bill.lines.some((l) => l.id === line.id)) throw new DomainError(`Line ${line.id} is not on ${bill.number}`, 400);
        await tx.vendorBillLine.update({ where: { id: line.id }, data: { qty: line.qty, unitCostCents: line.unitCostCents, discountCents: line.discountCents, amountCents: line.amountCents } });
      }
      if (vendorChanged && bill.poId && body.vendorId) {
        await tx.purchaseOrder.updateMany({ where: { id: bill.poId, vendorId: null }, data: { vendorId: body.vendorId } });
      }
      await recomputeTotals(tx, id);
      return tx.vendorBill.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  });

  app.get("/api/bills/:id/preview", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, (tx) => previewBill(tx, id));
  });

  app.post("/api/bills/:id/post", async (request) => {
    const { id } = parse(idParam, request.params);
    const { version } = parse(z.object({ version: z.number().int().min(0) }), request.body);
    return inTx(db, async (tx) => {
      const kind = (await tx.vendorBill.findUniqueOrThrow({ where: { id } })).kind;
      const ctx = { tx, actor: actorOf(request) };
      const bill = kind === "INVENTORY" ? await postInventoryBill(ctx, id, version) : await postFreightBill(ctx, id, version);
      await audit(tx, actorOf(request), "bill.posted", "VendorBill", id, { totalCents: bill.totalCents });
      return bill;
    });
  });

  app.delete("/api/bills/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, async (tx) => {
      const updated = await tx.vendorBill.updateMany({ where: { id, status: "DRAFT" }, data: { status: "VOID", voidedAt: new Date(), voidedBy: actorOf(request) } });
      if (updated.count === 0) throw new DomainError("Only a draft bill can be discarded; void a posted one instead", 409);
      const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id } });
      if (bill.poId) await refreshPoStatus(tx, bill.poId);
      return bill;
    });
  });

  // ── Receipts and the unit registers ──
  app.get("/api/receipts", async (request) => {
    const { state } = parse(z.object({ state: z.string().optional() }), request.query);
    const receipts = await db.warehouseReceipt.findMany({ where: state ? { state } : {}, include: { lines: true, po: true }, orderBy: { id: "desc" }, take: 200 });
    return receipts;
  });

  app.get("/api/registers", async (request) => {
    const q = parse(z.object({ register: z.enum(["WH_IN", "WH_OUT", "ADJ"]).optional(), itemId: z.coerce.number().int().optional() }), request.query);
    return db.stockMovement.findMany({ where: { ...(q.register ? { register: q.register } : {}), ...(q.itemId ? { itemId: q.itemId } : {}) }, orderBy: { id: "desc" }, take: 500 });
  });
}
