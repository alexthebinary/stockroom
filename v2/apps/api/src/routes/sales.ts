import { DomainError, paymentStatus, receivingStatus, State } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { DAY, daysLate } from "../aging";
import { audit } from "../audit";
import { inTx, type Db, type Tx } from "../db";
import { actorOf, idParam, notFound, parse } from "../http";
import { postEntry, reverseEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits } from "../stock";
import { transition } from "../transition";

/**
 * Sales orders mirror purchase orders: the order itself posts nothing.
 * Ship takes units out at average cost (Dr COGS / Cr Inventory). Invoice
 * recognises the sale (Dr Accounts Receivable / Cr Sales Revenue). A customer
 * payment clears the receivable (Dr Cash / Cr AR). Voiding an invoice reverses
 * only that entry; it does not put the units back.
 */

const lineBody = z.object({
  itemId: z.number().int().positive(),
  qtyOrdered: z.number().int().positive(),
  unitPriceCents: z.number().int().min(0),
});
const customerBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(40).nullish(),
  termsDays: z.number().int().min(0).max(365).optional(),
});
const lifecycleFilter = z.enum(["OPEN", "CANCELED", "CLOSED", "ALL"]);

type OrderLine = { id: number; itemId: number; qtyOrdered: number; qtyShipped: number; qtyInvoiced: number; unitPriceCents: number };

function invoicingOf(lines: { qtyOrdered: number; qtyInvoiced: number }[]) {
  const invoiced = lines.reduce((s, l) => s + l.qtyInvoiced, 0);
  if (invoiced === 0) return "NOT_INVOICED";
  return lines.every((l) => l.qtyInvoiced >= l.qtyOrdered) ? "INVOICED" : "PARTIAL";
}

function shippingOf(lines: { qtyOrdered: number; qtyShipped: number }[]) {
  const raw = receivingStatus(lines.map((l) => ({ qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyShipped })));
  if (raw === "NOT_RECEIVED") return "NOT_SHIPPED";
  if (raw === "RECEIVED") return "SHIPPED";
  return "PARTIAL";
}

/** Tax = (subtotal + shipping) x rate, rounded to the cent. Total = subtotal + shipping + tax. */
export function salesTotals(subtotalCents: number, shippingCents: number, taxRateBps: number) {
  const taxCents = Math.round(((subtotalCents + shippingCents) * taxRateBps) / 10000);
  return { subtotalCents, shippingCents, taxRateBps, taxRatePct: taxRateBps / 100, taxCents, totalCents: subtotalCents + shippingCents + taxCents };
}
const orderTotals = (o: { lines: { qtyOrdered: number; unitPriceCents: number }[]; shippingCents: number; taxRateBps: number }) =>
  salesTotals(o.lines.reduce((s, l) => s + l.qtyOrdered * l.unitPriceCents, 0), o.shippingCents, o.taxRateBps);
const chargeFields = {
  shippingCents: z.number().int().min(0).max(100_000_000).optional(),
  taxRatePct: z.number().min(0).max(100).optional(),
};
const bpsOf = (pct: number) => Math.round(pct * 100);

const dueDateFor = (invoiceDate: Date, termsDays: number) => new Date(invoiceDate.getTime() + termsDays * DAY);

async function lockOrder(tx: Tx, id: number) {
  const rows = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "SalesOrder" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Sales order");
}

async function refreshSalesOrder(tx: Tx, id: number) {
  const so = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true, invoices: true } });
  const posted = so.invoices.filter((i) => i.status === State.customerInvoice.POSTED);
  const owed = posted.reduce((s, i) => s + i.totalCents, 0);
  const paid = posted.reduce((s, i) => s + i.paidCents, 0);
  return tx.salesOrder.update({
    where: { id },
    data: {
      invoicingStatus: invoicingOf(so.lines),
      paymentStatus: posted.length === 0 ? "UNPAID" : paymentStatus(owed, paid),
      shippingStatus: shippingOf(so.lines),
      version: { increment: 1 },
    },
    include: { lines: true, invoices: true },
  });
}

async function assertSellable(tx: Tx, lines: { itemId: number }[]) {
  const ids = lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new DomainError("Each item can appear only once; add up the quantity instead", 400);
  const items = await tx.item.findMany({ where: { id: { in: ids } } });
  for (const id of ids) {
    const item = items.find((i) => i.id === id);
    if (!item || !item.isActive) throw new DomainError(`Item ${id} is not an active item`, 400);
    if (item.isBundle) throw new DomainError(`${item.name} is a bundle; sell its component items, or ship the bundle from stock`, 400);
    if (item.trackingMode === "SERIAL") throw new DomainError(`${item.name} is serial-tracked; serial items can't be sold on a sales order yet`, 400);
  }
  return items;
}

async function presentOrders(db: Db, orders: { customerId: number | null; lines: OrderLine[] }[]) {
  const [customers, items] = await Promise.all([
    db.customer.findMany({ where: { id: { in: orders.flatMap((o) => (o.customerId == null ? [] : [o.customerId])) } } }),
    db.item.findMany({
      where: { id: { in: [...new Set(orders.flatMap((o) => o.lines.map((l) => l.itemId)))] } },
      select: { id: true, sku: true, name: true },
    }),
  ]);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return { customers, itemsById };
}

export function registerSales(app: FastifyInstance, { db }: Deps) {
  app.get("/api/customers", async () => db.customer.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }));

  app.post("/api/customers", async (request) => {
    const body = parse(customerBody, request.body);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const customer = await tx.customer.create({
        data: { name: body.name, email: body.email || null, phone: body.phone || null, termsDays: body.termsDays ?? 30 },
      });
      await audit(tx, actor, "customer.created", "Customer", customer.id, { name: customer.name });
      return customer;
    });
  });

  app.get("/api/sales-orders", async (request) => {
    const q = parse(
      z.object({
        lifecycle: lifecycleFilter.default(State.soLifecycle.OPEN),
        invoicingStatus: z.enum(["NOT_INVOICED", "PARTIAL", "INVOICED"]).optional(),
        paymentStatus: z.enum(["UNPAID", "PARTIAL", "PAID"]).optional(),
        shippingStatus: z.enum(["NOT_SHIPPED", "PARTIAL", "SHIPPED"]).optional(),
        customerId: z.coerce.number().int().optional(),
        search: z.string().optional(),
      }),
      request.query,
    );
    const orders = await db.salesOrder.findMany({
      where: {
        ...(q.lifecycle !== "ALL" ? { lifecycle: q.lifecycle } : {}),
        ...(q.invoicingStatus ? { invoicingStatus: q.invoicingStatus } : {}),
        ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
        ...(q.shippingStatus ? { shippingStatus: q.shippingStatus } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.search ? { number: { contains: q.search, mode: "insensitive" as const } } : {}),
      },
      include: { lines: true },
      orderBy: { id: "desc" },
      take: 200,
    });
    const { customers, itemsById } = await presentOrders(db, orders);
    return orders.map((o) => ({
      ...o,
      lines: o.lines.map((line) => ({ ...line, item: itemsById.get(line.itemId) })),
      customer: customers.find((c) => c.id === o.customerId) ?? null,
      ...orderTotals(o),
    }));
  });

  app.get("/api/sales-orders/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const so = await db.salesOrder.findUnique({ where: { id }, include: { lines: true, invoices: { orderBy: { id: "asc" } }, customer: true } });
    if (!so) throw notFound("Sales order");
    const [items, warehouse] = await Promise.all([
      db.item.findMany({ where: { id: { in: so.lines.map((l) => l.itemId) } }, select: { id: true, sku: true, name: true } }),
      db.warehouse.findUnique({ where: { id: so.warehouseId } }),
    ]);
    return {
      ...so,
      warehouse,
      ...orderTotals(so),
      lines: so.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId) })),
      invoices: so.invoices.map((i) => ({ ...i, openCents: i.status === State.customerInvoice.POSTED ? i.totalCents - i.paidCents : 0 })),
    };
  });

  app.post("/api/sales-orders", async (request) => {
    const body = parse(
      z.object({
        customerId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        notes: z.string().max(2000).optional(),
        ...chargeFields,
        lines: z.array(lineBody).min(1),
      }),
      request.body,
    );
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: body.customerId } });
      if (!customer || !customer.isActive) throw new DomainError("That customer was not found", 400);
      const warehouse = await tx.warehouse.findUnique({ where: { id: body.warehouseId } });
      if (!warehouse || !warehouse.isActive) throw new DomainError("That warehouse was not found", 400);
      await assertSellable(tx, body.lines);
      const number = await nextNumber(tx, "SO");
      const so = await tx.salesOrder.create({
        data: {
          number,
          customerId: customer.id,
          warehouseId: warehouse.id,
          notes: body.notes,
          shippingCents: body.shippingCents ?? 0,
          taxRateBps: bpsOf(body.taxRatePct ?? 0),
          createdBy: actor,
          lines: { create: body.lines.map((l) => ({ itemId: l.itemId, qtyOrdered: l.qtyOrdered, unitPriceCents: l.unitPriceCents })) },
        },
        include: { lines: true },
      });
      await audit(tx, actor, "so.created", "SalesOrder", so.id, { number });
      return so;
    });
  });

  app.put("/api/sales-orders/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({
        version: z.number().int(),
        customerId: z.number().int().positive().nullish(),
        notes: z.string().max(2000).nullish(),
        ...chargeFields,
        lines: z.array(lineBody.extend({ id: z.number().int().positive().optional() })).optional(),
      }),
      request.body,
    );
    return inTx(db, async (tx) => {
      await lockOrder(tx, id);
      const so = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (so.version !== body.version) throw new DomainError(`${so.number} was changed by someone else. Reload it.`, 409);
      if (so.lifecycle !== State.soLifecycle.OPEN) throw new DomainError(`${so.number} is cancelled`, 409);
      if (body.customerId) {
        const customer = await tx.customer.findUnique({ where: { id: body.customerId } });
        if (!customer || !customer.isActive) throw new DomainError("That customer was not found", 400);
      }
      if (body.lines) {
        await assertSellable(tx, body.lines);
        for (const existing of so.lines) {
          const next = body.lines.find((l) => l.id === existing.id);
          const floor = Math.max(existing.qtyShipped, existing.qtyInvoiced);
          if (!next && floor > 0) throw new DomainError("A line that has shipped or been invoiced can't be removed", 409);
          if (next && next.qtyOrdered < floor) throw new DomainError(`A line can't be ordered below the ${floor} already shipped or invoiced`, 409);
          if (next && existing.qtyInvoiced > 0 && next.unitPriceCents !== existing.unitPriceCents) {
            throw new DomainError("A line that has been invoiced keeps its price", 409);
          }
          if (!next) await tx.salesOrderLine.delete({ where: { id: existing.id } });
          else await tx.salesOrderLine.update({ where: { id: existing.id }, data: { qtyOrdered: next.qtyOrdered, unitPriceCents: next.unitPriceCents } });
        }
        for (const added of body.lines.filter((l) => !l.id)) {
          await tx.salesOrderLine.create({ data: { salesOrderId: id, itemId: added.itemId, qtyOrdered: added.qtyOrdered, unitPriceCents: added.unitPriceCents } });
        }
      }
      await tx.salesOrder.update({
        where: { id },
        data: {
          customerId: body.customerId === undefined ? undefined : body.customerId,
          notes: body.notes === undefined ? undefined : body.notes,
          shippingCents: body.shippingCents,
          taxRateBps: body.taxRatePct === undefined ? undefined : bpsOf(body.taxRatePct),
        },
      });
      await audit(tx, actorOf(request), "so.updated", "SalesOrder", id);
      return refreshSalesOrder(tx, id);
    });
  });

  app.post("/api/sales-orders/:id/cancel", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, async (tx) => {
      await lockOrder(tx, id);
      const so = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true, invoices: true } });
      if (so.lines.some((l) => l.qtyShipped > 0)) throw new DomainError(`${so.number} has shipped stock and can't be cancelled`, 409);
      if (so.invoices.some((i) => i.status === State.customerInvoice.POSTED)) throw new DomainError(`${so.number} has a posted invoice; void the invoice first`, 409);
      const actor = actorOf(request);
      await transition({
        machine: "soLifecycle",
        to: State.soLifecycle.CANCELED,
        label: "Sales order",
        apply: async (sources, to) => (await tx.salesOrder.updateMany({ where: { id, lifecycle: { in: sources } }, data: { lifecycle: to } })).count,
        current: async () => (await tx.salesOrder.findUnique({ where: { id }, select: { lifecycle: true } }))?.lifecycle ?? null,
      });
      await audit(tx, actor, "so.cancelled", "SalesOrder", id);
      return tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  });

  /** Ship remaining units, or the quantities named. Stock leaves at average cost. */
  app.post("/api/sales-orders/:id/ship", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({ lines: z.array(z.object({ lineId: z.number().int().positive(), qty: z.number().int().positive() })).min(1).optional() }),
      request.body,
    );
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      await lockOrder(tx, id);
      const so = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (so.lifecycle !== State.soLifecycle.OPEN) throw new DomainError(`${so.number} is cancelled`, 409);
      const wanted = body.lines ?? so.lines.filter((l) => l.qtyOrdered > l.qtyShipped).map((l) => ({ lineId: l.id, qty: l.qtyOrdered - l.qtyShipped }));
      if (wanted.length === 0) throw new DomainError(`${so.number} has nothing left to ship`, 409);
      const items = await tx.item.findMany({ where: { id: { in: so.lines.map((l) => l.itemId) } } });
      const warehouse = await tx.warehouse.findUnique({ where: { id: so.warehouseId } });
      const plan: { line: (typeof so.lines)[number]; qty: number; name: string }[] = [];
      for (const ask of wanted) {
        const line = so.lines.find((l) => l.id === ask.lineId);
        if (!line) throw new DomainError("That line is not on this sales order", 400);
        const left = line.qtyOrdered - line.qtyShipped;
        if (ask.qty > left) throw new DomainError(`Only ${left} left to ship on that line`, 409);
        const item = items.find((i) => i.id === line.itemId);
        if (!item) throw new DomainError(`Item ${line.itemId} was not found`, 400);
        if (item.trackingMode === "SERIAL") throw new DomainError(`${item.name} is serial-tracked; serial items can't be shipped on a sales order yet`, 400);
        const balance = await tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: line.itemId, warehouseId: so.warehouseId } } });
        const have = balance ? balance.onHand - balance.reserved : 0;
        if (have < ask.qty) throw new DomainError(`Not enough ${item.name} (${item.sku}): shipping needs ${ask.qty}, ${have} available at ${warehouse?.code ?? "that warehouse"}`, 400);
        plan.push({ line, qty: ask.qty, name: item.name });
      }
      const docNumber = await nextNumber(tx, "WH_OUT");
      const counter = { type: "SALES_ORDER" as const, id: so.id };
      const issued: { itemId: number; qty: number; valueCents: number }[] = [];
      for (const step of plan) {
        const valueCents = await issueUnits({ tx, actor }, { itemId: step.line.itemId, warehouseId: so.warehouseId, qty: step.qty, docNumber, counter });
        await tx.salesOrderLine.update({ where: { id: step.line.id }, data: { qtyShipped: { increment: step.qty } } });
        issued.push({ itemId: step.line.itemId, qty: step.qty, valueCents });
      }
      const valueCents = issued.reduce((s, l) => s + l.valueCents, 0);
      await postEntry(tx, {
        event: "SALES_SHIPPED",
        date: new Date(),
        sourceType: "SALES_SHIP",
        sourceId: so.id,
        actor,
        memo: `${docNumber}: ${so.number}`,
        lines: issued.flatMap((l) => [
          { role: "cogs" as const, amountCents: l.valueCents, itemId: l.itemId },
          { role: "inventoryOnHand" as const, amountCents: l.valueCents, itemId: l.itemId },
        ]),
      });
      await audit(tx, actor, "so.shipped", "SalesOrder", so.id, { docNumber, valueCents });
      const order = await refreshSalesOrder(tx, id);
      return { docNumber, valueCents, lines: issued, order };
    });
  });

  /** Invoice whatever is still uninvoiced, at the order price. Posts immediately. */
  app.post("/api/sales-orders/:id/invoice", async (request) => {
    const { id } = parse(idParam, request.params);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      await lockOrder(tx, id);
      const so = await tx.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true, customer: true, invoices: true } });
      if (so.lifecycle !== State.soLifecycle.OPEN) throw new DomainError(`${so.number} is cancelled`, 409);
      if (!so.customer) throw new DomainError(`${so.number} needs a customer before it can be invoiced`, 400);
      const open = so.lines.filter((l) => l.qtyOrdered > l.qtyInvoiced);
      if (open.length === 0) throw new DomainError(`${so.number} is already invoiced`, 409);
      const priced = open.map((l) => {
        const qty = l.qtyOrdered - l.qtyInvoiced;
        return { line: l, qty, amountCents: qty * l.unitPriceCents };
      });
      const subtotalCents = priced.reduce((s, l) => s + l.amountCents, 0);
      // Shipping & handling is billed once: whatever earlier posted invoices have not already charged.
      const billedShipping = so.invoices.filter((i) => i.status === State.customerInvoice.POSTED).reduce((s, i) => s + i.shippingCents, 0);
      const totals = salesTotals(subtotalCents, Math.max(0, so.shippingCents - billedShipping), so.taxRateBps);
      const totalCents = totals.totalCents;
      if (subtotalCents <= 0) throw new DomainError(`${so.number} has no amount left to invoice`, 409);
      const invoiceDate = new Date();
      const termsDays = so.customer.termsDays;
      const number = await nextNumber(tx, "INV");
      const invoice = await tx.customerInvoice.create({
        data: {
          number,
          status: State.customerInvoice.DRAFT,
          customerId: so.customer.id,
          salesOrderId: so.id,
          invoiceDate,
          termsDays,
          dueDate: dueDateFor(invoiceDate, termsDays),
          subtotalCents,
          shippingCents: totals.shippingCents,
          taxRateBps: totals.taxRateBps,
          taxCents: totals.taxCents,
          totalCents,
          lines: {
            create: priced.map((l) => ({
              salesOrderLineId: l.line.id,
              itemId: l.line.itemId,
              qty: l.qty,
              unitPriceCents: l.line.unitPriceCents,
              amountCents: l.amountCents,
            })),
          },
        },
      });
      await transition({
        machine: "customerInvoice",
        to: State.customerInvoice.POSTED,
        label: number,
        apply: async (sources, to) => (await tx.customerInvoice.updateMany({
          where: { id: invoice.id, status: { in: sources } },
          data: { status: to, postedAt: invoiceDate, postedBy: actor },
        })).count,
        current: async () => (await tx.customerInvoice.findUnique({ where: { id: invoice.id }, select: { status: true } }))?.status ?? null,
      });
      await postEntry(tx, {
        event: "INVOICE_POSTED",
        date: invoiceDate,
        sourceType: "CUSTOMER_INVOICE",
        sourceId: invoice.id,
        actor,
        memo: `${number}: ${so.number}`,
        lines: [
          { role: "receivable" as const, amountCents: totalCents, customerId: so.customer.id },
          { role: "revenue" as const, amountCents: totalCents },
        ],
      });
      for (const l of priced) await tx.salesOrderLine.update({ where: { id: l.line.id }, data: { qtyInvoiced: { increment: l.qty } } });
      await audit(tx, actor, "invoice.posted", "CustomerInvoice", invoice.id, { number, totalCents, salesOrderId: so.id });
      await refreshSalesOrder(tx, id);
      return tx.customerInvoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { lines: true } });
    });
  });

  app.get("/api/customer-invoices", async () => {
    const invoices = await db.customerInvoice.findMany({
      include: { customer: true, salesOrder: { select: { id: true, number: true } } },
      orderBy: { id: "desc" },
      take: 200,
    });
    return invoices.map((i) => ({ ...i, openCents: i.status === State.customerInvoice.POSTED ? i.totalCents - i.paidCents : 0 }));
  });

  app.get("/api/customer-invoices/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const invoice = await db.customerInvoice.findUnique({
      where: { id },
      include: { lines: true, payments: { orderBy: { id: "asc" } }, customer: true, salesOrder: { select: { id: true, number: true } } },
    });
    if (!invoice) throw notFound("Invoice");
    const items = await db.item.findMany({ where: { id: { in: invoice.lines.flatMap((l) => (l.itemId == null ? [] : [l.itemId])) } }, select: { id: true, sku: true, name: true } });
    return {
      ...invoice,
      taxRatePct: invoice.taxRateBps / 100,
      openCents: invoice.status === State.customerInvoice.POSTED ? invoice.totalCents - invoice.paidCents : 0,
      lines: invoice.lines.map((l) => ({ ...l, item: items.find((i) => i.id === l.itemId) ?? null })),
    };
  });

  app.post("/api/customer-invoices/:id/void", async (request) => {
    const { id } = parse(idParam, request.params);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const locked = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "CustomerInvoice" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw notFound("Invoice");
      const invoice = await tx.customerInvoice.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (invoice.paidCents > 0) throw new DomainError(`${invoice.number} has a payment, so it can't be voided`, 409);
      await transition({
        machine: "customerInvoice",
        to: State.customerInvoice.VOID,
        from: [State.customerInvoice.POSTED],
        label: invoice.number,
        apply: async (sources, to) => (await tx.customerInvoice.updateMany({
          where: { id, status: { in: sources } },
          data: { status: to, voidedAt: new Date(), voidedBy: actor },
        })).count,
        current: async () => (await tx.customerInvoice.findUnique({ where: { id }, select: { status: true } }))?.status ?? null,
      });
      const entry = await tx.journalEntry.findFirst({ where: { sourceType: "CUSTOMER_INVOICE", sourceId: id, reversesId: null } });
      if (!entry) throw new DomainError(`${invoice.number} has no entry to reverse`, 409);
      await reverseEntry(tx, entry.id, actor);
      for (const line of invoice.lines) {
        if (line.salesOrderLineId) await tx.salesOrderLine.update({ where: { id: line.salesOrderLineId }, data: { qtyInvoiced: { decrement: line.qty } } });
      }
      if (invoice.salesOrderId) {
        await lockOrder(tx, invoice.salesOrderId);
        await refreshSalesOrder(tx, invoice.salesOrderId);
      }
      await audit(tx, actor, "invoice.voided", "CustomerInvoice", id);
      return tx.customerInvoice.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  });

  app.post("/api/customer-invoices/:id/payments", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({
        amountCents: z.number().int().positive(),
        method: z.string().trim().min(1).max(40).default("BANK"),
        paidAt: z.coerce.date().optional(),
        memo: z.string().trim().max(300).nullish(),
      }),
      request.body,
    );
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const locked = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "CustomerInvoice" WHERE "id" = ${id} FOR UPDATE`;
      if (locked.length === 0) throw notFound("Invoice");
      const invoice = await tx.customerInvoice.findUniqueOrThrow({ where: { id } });
      if (invoice.status !== State.customerInvoice.POSTED) throw new DomainError("Only a posted invoice can be paid", 409);
      const paidAt = body.paidAt ?? new Date();
      if (paidAt.getTime() > Date.now() + 60_000) throw new DomainError("A payment can't be dated in the future", 400);
      const open = invoice.totalCents - invoice.paidCents;
      if (body.amountCents > open) {
        throw new DomainError(open <= 0 ? `${invoice.number} has nothing left to pay` : `Only $${(open / 100).toFixed(2)} is open on ${invoice.number}`, 409);
      }
      const number = await nextNumber(tx, "CP");
      const payment = await tx.customerPayment.create({
        data: {
          number,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          amountCents: body.amountCents,
          method: body.method,
          paidAt,
          memo: body.memo ?? null,
          actor,
        },
      });
      await postEntry(tx, {
        event: "CUSTOMER_PAYMENT",
        date: paidAt,
        sourceType: "CUSTOMER_PAYMENT",
        sourceId: payment.id,
        actor,
        memo: `${number} · ${invoice.number}`,
        lines: [
          { role: "bank" as const, amountCents: body.amountCents },
          { role: "receivable" as const, amountCents: body.amountCents, customerId: invoice.customerId },
        ],
      });
      await tx.customerInvoice.update({ where: { id }, data: { paidCents: { increment: body.amountCents } } });
      if (invoice.salesOrderId) {
        await lockOrder(tx, invoice.salesOrderId);
        await refreshSalesOrder(tx, invoice.salesOrderId);
      }
      await audit(tx, actor, "customerPayment.posted", "CustomerPayment", payment.id, { number, invoiceId: id, amountCents: body.amountCents });
      return payment;
    });
  });

  /** What customers owe, by customer, aged by days past the due date. */
  app.get("/api/reports/ar-aging", async (request) => {
    const { asOf } = parse(z.object({ asOf: z.coerce.date().default(() => new Date()) }), request.query);
    const { invoices, customers, outstanding } = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const invoices = await tx.customerInvoice.findMany({ where: { invoiceDate: { lte: asOf } }, orderBy: { dueDate: "asc" } });
      const invoiceIds = invoices.map((i) => i.id);
      const [customers, payments] = await Promise.all([
        tx.customer.findMany({ where: { id: { in: invoices.map((i) => i.customerId) } } }),
        tx.customerPayment.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true, invoiceId: true } }),
      ]);
      const paymentInvoices = new Map(payments.map((p) => [p.id, p.invoiceId]));
      const lines = await tx.journalLine.findMany({
        where: {
          role: "receivable",
          entry: {
            date: { lte: asOf },
            OR: [
              { sourceType: "CUSTOMER_INVOICE", sourceId: { in: invoiceIds } },
              { sourceType: "CUSTOMER_PAYMENT", sourceId: { in: payments.map((p) => p.id) } },
            ],
          },
        },
        include: { entry: { select: { sourceType: true, sourceId: true } } },
      });
      const outstanding = new Map<number, number>();
      for (const line of lines) {
        const { sourceType, sourceId } = line.entry;
        const invoiceId = sourceType === "CUSTOMER_PAYMENT" ? paymentInvoices.get(sourceId) : sourceId;
        if (invoiceId != null) outstanding.set(invoiceId, (outstanding.get(invoiceId) ?? 0) + (line.side === "DEBIT" ? line.amountCents : -line.amountCents));
      }
      return { invoices, customers, outstanding };
    }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
    const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
    const bucketOf = (due: Date) => {
      const late = daysLate(due, asOf);
      if (late <= 0) return "current";
      if (late <= 30) return "1-30";
      if (late <= 60) return "31-60";
      if (late <= 90) return "61-90";
      return "90+";
    };
    const open = invoices.map((i) => ({ ...i, openCents: outstanding.get(i.id) ?? 0 })).filter((i) => i.openCents !== 0);
    const byCustomer = customers.map((c) => {
      const mine = open.filter((i) => i.customerId === c.id);
      const row = Object.fromEntries(buckets.map((k) => [k, mine.filter((i) => bucketOf(i.dueDate) === k).reduce((s, i) => s + i.openCents, 0)]));
      return {
        customer: c,
        ...row,
        totalCents: mine.reduce((s, i) => s + i.openCents, 0),
        invoices: mine.map((i) => ({ id: i.id, number: i.number, salesOrderId: i.salesOrderId, dueDate: i.dueDate, openCents: i.openCents, bucket: bucketOf(i.dueDate) })),
      };
    });
    return { asOf, buckets, customers: byCustomer.filter((c) => c.totalCents !== 0) };
  });
}
