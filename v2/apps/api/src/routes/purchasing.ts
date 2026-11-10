import { Axis, BILL_STATES, BILLING_STATUSES, DomainError, PAYMENT_STATUSES, PO_LIFECYCLE_FILTERS, RECEIPT_STATES, RECEIVING_STATUSES, SCAN_STATES, State } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx, Prisma, type Db } from "../db";
import { actorOf, idParam, notFound, parse } from "../http";
import { transition } from "../transition";
import { dueDateFor, draftBillFromPo, postInventoryBill, previewBill, recomputeTotals } from "../purchasing/bills";
import { postFreightBill } from "../purchasing/freight";
import { lockBill } from "../purchasing/locks";
import { createPo, refreshPoStatus } from "../purchasing/po";
import { receive } from "../purchasing/receive";
import { movementType } from "./reports";
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
        billingStatus: z.enum(BILLING_STATUSES).optional(),
        receivingStatus: z.enum(RECEIVING_STATUSES).optional(),
        paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
        vendorId: z.coerce.number().int().optional(),
        search: z.string().optional(),
        lifecycle: z.enum(PO_LIFECYCLE_FILTERS).default(State.poLifecycle.OPEN),
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
    const items = await db.item.findMany({
      where: { id: { in: [...new Set(orders.flatMap((o) => o.lines.map((l) => l.itemId)))] } },
      select: { id: true, sku: true, name: true },
    });
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return orders.map((o) => ({
      ...o,
      lines: o.lines.map((line) => ({ ...line, item: itemsById.get(line.itemId) })),
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
      if (po.billingStatus === Axis.billing.BILLED) throw new DomainError(`${po.number} has a posted bill; change what was bought with a vendor credit instead`, 409);
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
      if (body.vendorId) await tx.vendorBill.updateMany({ where: { poId: id, status: State.bill.DRAFT, vendorId: null }, data: { vendorId: body.vendorId } });
      return refreshPoStatus(tx, id);
    });
  });

  app.post("/api/purchase-orders/:id/cancel", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true, bills: true } });
      if (po.lines.some((l) => l.qtyReceived > 0)) throw new DomainError(`${po.number} has received stock and can't be cancelled`, 409);
      if (po.bills.some((b) => b.status === State.bill.POSTED)) throw new DomainError(`${po.number} has a posted bill; void the bill first`, 409);
      const actor = actorOf(request);
      await transition({
        machine: "bill",
        to: State.bill.VOID,
        from: [State.bill.DRAFT],
        label: "Bill",
        allowEmpty: true,
        apply: async (sources, to) => (await tx.vendorBill.updateMany({
          where: { poId: id, status: { in: sources } },
          data: { status: to, voidedAt: new Date(), voidedBy: actor },
        })).count,
        current: async () => null,
      });
      await audit(tx, actor, "po.cancelled", "PurchaseOrder", id);
      await transition({
        machine: "poLifecycle",
        to: State.poLifecycle.CANCELED,
        label: "Purchase order",
        apply: async (sources, to) => (await tx.purchaseOrder.updateMany({
          where: { id, lifecycle: { in: sources } },
          data: { lifecycle: to },
        })).count,
        current: async () => (await tx.purchaseOrder.findUnique({ where: { id }, select: { lifecycle: true } }))?.lifecycle ?? null,
      });
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
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
      where: { lifecycle: State.poLifecycle.OPEN, receivingStatus: { not: Axis.receiving.RECEIVED }, ...(warehouseId ? { warehouseId } : {}), ...(vendorId ? { vendorId } : {}) },
      include: { lines: true },
      orderBy: { id: "asc" },
    });
    const items = await db.item.findMany({ where: { id: { in: orders.flatMap((o) => o.lines.map((l) => l.itemId)) } } });
    const vendors = await db.vendor.findMany({ where: { id: { in: orders.map((o) => o.vendorId!).filter(Boolean) } } });
    return orders.map((o) => ({
      id: o.id,
      number: o.number,
      warehouseId: o.warehouseId,
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
    const { status } = parse(z.object({ status: z.enum(SCAN_STATES).default(State.scanSession.OPEN) }), request.query);
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
    await transition({
      machine: "scanSession",
      to: State.scanSession.OPEN,
      from: [State.scanSession.OPEN],
      label: "Delivery",
      message: "This delivery is already finished",
      apply: async (sources, to) => (await db.scanSession.updateMany({
        where: { id, status: { in: sources } },
        data: { status: to, vendorId: body.vendorId, poId: body.poId, notes: body.notes, slipRead: body.slipRead === undefined ? undefined : (body.slipRead as Prisma.InputJsonValue) },
      })).count,
      current: async () => (await db.scanSession.findUnique({ where: { id }, select: { status: true } }))?.status ?? null,
    });
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
    await transition({
      machine: "scanSession",
      to: State.scanSession.ABANDONED,
      from: [State.scanSession.OPEN],
      label: "Delivery",
      message: "Only an unfinished delivery can be abandoned",
      apply: async (sources, to) => (await db.scanSession.updateMany({ where: { id, status: { in: sources } }, data: { status: to } })).count,
      current: async () => (await db.scanSession.findUnique({ where: { id }, select: { status: true } }))?.status ?? null,
    });
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
    const sessions = await db.scanSession.findMany({ where: { status: State.scanSession.SUBMITTED }, orderBy: { id: "desc" }, take: 200 });
    return sessions.flatMap((s) => {
      const result = s.result as { unknown?: { code: string | null; name: string | null; qty: number }[] } | null;
      return (result?.unknown ?? []).map((u) => ({ sessionId: s.id, submittedAt: s.submittedAt, startedBy: s.startedBy, ...u }));
    });
  });

  // ── Vendor bills ──
  app.get("/api/bills", async (request) => {
    const q = parse(z.object({ status: z.enum(BILL_STATES).optional(), kind: z.string().optional(), vendorId: z.coerce.number().int().optional(), open: z.coerce.boolean().optional() }), request.query);
    const bills = await db.vendorBill.findMany({
      where: { ...(q.status ? { status: q.status } : { status: { not: State.bill.VOID } }), ...(q.kind ? { kind: q.kind } : {}), ...(q.vendorId ? { vendorId: q.vendorId } : {}) },
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
        openCents: b.status === State.bill.POSTED ? b.totalCents - b.paidCents - b.creditedCents : 0,
      }))
      .filter((b) => !q.open || b.openCents !== 0);
  });

  app.get("/api/bills/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const bill = await db.vendorBill.findUnique({ where: { id }, include: { lines: true, allocations: true, po: { include: { lines: true } } } });
    if (!bill) throw notFound("Bill");
    const [vendor, items, payments, credits, preview, match] = await Promise.all([
      bill.vendorId ? db.vendor.findUnique({ where: { id: bill.vendorId } }) : null,
      db.item.findMany({ where: { id: { in: bill.lines.map((l) => l.itemId!).filter(Boolean) } } }),
      db.payment.findMany({ where: { billId: id }, orderBy: { id: "asc" } }),
      db.vendorCredit.findMany({ where: { billId: id }, include: { lines: true }, orderBy: { id: "asc" } }),
      bill.status === State.bill.DRAFT ? inTx(db, (tx) => previewBill(tx, id)) : null,
      orderMatch(db, bill),
    ]);
    return {
      ...bill,
      vendor,
      payments,
      credits,
      preview,
      match,
      openCents: bill.status === State.bill.POSTED ? bill.totalCents - bill.paidCents - bill.creditedCents : 0,
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
      await lockBill(tx, id);
      const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (bill.status !== State.bill.DRAFT) throw new DomainError(`${bill.number} is ${bill.status.toLowerCase()} and can't be edited`, 409);
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
      await transition({
        machine: "bill",
        to: State.bill.VOID,
        from: [State.bill.DRAFT],
        label: "Bill",
        message: "Only a draft bill can be discarded; void a posted one instead",
        apply: async (sources, to) => (await tx.vendorBill.updateMany({
          where: { id, status: { in: sources } },
          data: { status: to, voidedAt: new Date(), voidedBy: actorOf(request) },
        })).count,
        current: async () => (await tx.vendorBill.findUnique({ where: { id }, select: { status: true } }))?.status ?? null,
      });
      const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id } });
      if (bill.poId) await refreshPoStatus(tx, bill.poId);
      return bill;
    });
  });

  // ── Receipts and the unit registers ──
  app.get("/api/receipts", async (request) => {
    const { state } = parse(z.object({ state: z.enum(RECEIPT_STATES).optional() }), request.query);
    const receipts = await db.warehouseReceipt.findMany({ where: state ? { state } : {}, include: { lines: true, po: true }, orderBy: { id: "desc" }, take: 200 });
    return receipts;
  });

  /** One warehouse receipt, with the order it answers, the vendor, the warehouse and the items counted. */
  app.get("/api/receipts/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const receipt = await db.warehouseReceipt.findUnique({ where: { id }, include: { lines: true, po: true } });
    if (!receipt) throw notFound("Warehouse receipt");
    const [vendor, warehouse, items] = await Promise.all([
      receipt.po.vendorId ? db.vendor.findUnique({ where: { id: receipt.po.vendorId }, select: { id: true, name: true } }) : null,
      db.warehouse.findUnique({ where: { id: receipt.warehouseId }, select: { id: true, name: true, code: true } }),
      db.item.findMany({ where: { id: { in: receipt.lines.map((l) => l.itemId) } }, select: { id: true, sku: true, name: true } }),
    ]);
    return { ...receipt, vendor, warehouse, lines: receipt.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId) ?? null })) };
  });

  /** One numbered stock adjustment (ADJ-00001, …): its type, who posted it and every item line. */
  app.get("/api/other-transactions/:number", async (request) => {
    const { number } = parse(z.object({ number: z.string().regex(/^[A-Za-z0-9-]{1,40}$/) }), request.params);
    const moves = await db.stockMovement.findMany({ where: { register: "ADJ", docNumber: number, bucket: "ON_HAND" }, orderBy: { id: "asc" } });
    if (moves.length === 0) throw notFound("Stock adjustment");
    const [items, warehouses] = await Promise.all([
      db.item.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.itemId))] } }, select: { id: true, sku: true, name: true } }),
      db.warehouse.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.warehouseId))] } }, select: { id: true, name: true, code: true } }),
    ]);
    const first = moves[0]!;
    return {
      number,
      type: movementType(first),
      date: first.createdAt.toISOString(),
      actor: first.actor,
      qty: moves.reduce((n, m) => n + m.qtyDelta, 0),
      lines: moves.map((m) => ({ id: m.id, qty: m.qtyDelta, valueCents: m.valueCents, item: items.find((i) => i.id === m.itemId) ?? null, warehouse: warehouses.find((w) => w.id === m.warehouseId) ?? null })),
    };
  });

  /** Opening stock and adjustments, one row per numbered document (ADJ-00001, …), newest first. */
  app.get("/api/other-transactions", async () => {
    const moves = await db.stockMovement.findMany({ where: { register: "ADJ", bucket: "ON_HAND" }, orderBy: { id: "desc" }, take: 1000 });
    const docs = new Map<string, { number: string; type: string; date: Date; qty: number; lines: number; actor: string }>();
    for (const m of moves) {
      const d = docs.get(m.docNumber);
      if (d) { d.qty += m.qtyDelta; d.lines += 1; } else docs.set(m.docNumber, { number: m.docNumber, type: movementType(m), date: m.createdAt, qty: m.qtyDelta, lines: 1, actor: m.actor });
    }
    return [...docs.values()].map((d) => ({ ...d, date: d.date.toISOString() }));
  });

  app.get("/api/registers", async (request) => {
    const q = parse(z.object({ register: z.enum(["WH_IN", "WH_OUT", "ADJ"]).optional(), itemId: z.coerce.number().int().optional() }), request.query);
    return db.stockMovement.findMany({ where: { ...(q.register ? { register: q.register } : {}), ...(q.itemId ? { itemId: q.itemId } : {}) }, orderBy: { id: "desc" }, take: 500 });
  });
}

/**
 * Advisory comparison of an inventory bill with its purchase order.
 * Read-only. Null for freight bills and bills that have no purchase order.
 * The same wording is formatted again in MatchPanel.tsx while a draft is being edited.
 */
export type MatchTone = "ok" | "warn" | "note";
export type MatchNote = { text: string; tone: MatchTone };
export type OrderMatch = {
  billLineId: number;
  itemId: number | null;
  itemName: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyThisBill: number;
  qtyAllBills: number;
  orderUnitCostCents: number;
  billUnitCostCents: number;
  /** Signed percent when the absolute gap over the order cost is over 1%. Null at 1% or less, and when the order cost is 0. */
  pricePercent: number | null;
  statuses: MatchNote[];
};

type MatchSource = {
  kind: string;
  po: { lines: { id: number; qtyOrdered: number; qtyReceived: number; unitCostCents: number }[] } | null;
  lines: { id: number; poLineId: number | null; itemId: number | null; qty: number; unitCostCents: number }[];
};

/** Signed percent, or null when the order cost is 0 or the gap is 1% or less. */
export function priceDriftPercent(orderUnitCostCents: number, billUnitCostCents: number): number | null {
  if (orderUnitCostCents <= 0) return null;
  const delta = billUnitCostCents - orderUnitCostCents;
  if (Math.abs(delta) * 100 <= orderUnitCostCents) return null;
  return Math.round((delta / orderUnitCostCents) * 10000) / 100;
}

export function formatSignedPercent(percent: number): string {
  const sign = percent > 0 ? "+" : "-";
  const body = (Math.round(Math.abs(percent) * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${sign}${body}%`;
}

/** Status chips for one line. "Matches" only when none of the checks apply. Quantity uses every open bill. */
export function matchStatus(input: {
  qtyOrdered: number;
  qtyReceived: number;
  qtyAllBills: number;
  orderUnitCostCents: number;
  billUnitCostCents: number;
}): MatchNote[] {
  const notes: MatchNote[] = [];
  const percent = priceDriftPercent(input.orderUnitCostCents, input.billUnitCostCents);
  if (percent != null) notes.push({ text: `Price differs by ${formatSignedPercent(percent)}`, tone: "warn" });
  else if (input.orderUnitCostCents <= 0 && input.billUnitCostCents !== input.orderUnitCostCents) notes.push({ text: "Price differs", tone: "warn" });
  if (input.qtyAllBills > input.qtyOrdered) notes.push({ text: "Billing more than ordered", tone: "warn" });
  if (input.qtyAllBills > input.qtyReceived) notes.push({ text: "Billing more than received", tone: "note" });
  if (notes.length === 0) notes.push({ text: "Matches", tone: "ok" });
  return notes;
}

export async function orderMatch(db: Db, bill: MatchSource): Promise<OrderMatch[] | null> {
  if (bill.kind !== "INVENTORY" || !bill.po) return null;
  const poLineIds = [...new Set(bill.lines.flatMap((l) => (l.poLineId == null ? [] : [l.poLineId])))];
  const [names, billed] = await Promise.all([
    db.item.findMany({ where: { id: { in: bill.lines.flatMap((l) => (l.itemId == null ? [] : [l.itemId])) } }, select: { id: true, name: true } }),
    poLineIds.length === 0
      ? Promise.resolve([])
      : db.vendorBillLine.findMany({
          where: { poLineId: { in: poLineIds }, bill: { kind: "INVENTORY", status: { not: State.bill.VOID } } },
          select: { poLineId: true, qty: true },
        }),
  ]);
  const qtyAll = new Map<number, number>();
  for (const line of billed) {
    if (line.poLineId == null) continue;
    qtyAll.set(line.poLineId, (qtyAll.get(line.poLineId) ?? 0) + line.qty);
  }
  const rows: OrderMatch[] = [];
  for (const line of bill.lines) {
    const poLine = bill.po.lines.find((p) => p.id === line.poLineId);
    if (!poLine || line.poLineId == null) continue;
    const qtyAllBills = qtyAll.get(line.poLineId) ?? line.qty;
    const compared = {
      qtyOrdered: poLine.qtyOrdered,
      qtyReceived: poLine.qtyReceived,
      qtyAllBills,
      orderUnitCostCents: poLine.unitCostCents,
      billUnitCostCents: line.unitCostCents,
    };
    rows.push({
      billLineId: line.id,
      itemId: line.itemId,
      itemName: names.find((i) => i.id === line.itemId)?.name ?? null,
      qtyThisBill: line.qty,
      pricePercent: priceDriftPercent(poLine.unitCostCents, line.unitCostCents),
      statuses: matchStatus(compared),
      ...compared,
    });
  }
  return rows;
}
