import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { parse } from "../http";

type SearchResult = { type: string; id: number; title: string; subtitle: string; url: string };

export function registerSearch(app: FastifyInstance, { db }: Deps) {
  app.get("/api/search", async (request) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2) }), request.query);
    if (!request.profile) throw new DomainError("Pick who's working first", 401);

    // Mirrors Shell's RAIL: everyone has orders/inventory; only accounting
    // and admins have Settings (vendors), Bills and Reports (journal).
    const accounting = ["ACCOUNTING", "ADMIN"].includes(request.profile.job);
    const match = { contains: q, mode: "insensitive" as const };
    // Vendor ids are scalar references in this schema, not Prisma relations.
    const matchingVendors = await db.vendor.findMany({ where: { name: match }, select: { id: true } });
    const vendorMatch = { in: matchingVendors.map((v) => v.id) };
    const limit = { take: 8, orderBy: { id: "desc" as const } };
    const [orders, bills, vendors, items, entries, credits, payments] = await Promise.all([
      db.purchaseOrder.findMany({ ...limit, where: { OR: [{ number: match }, { vendorId: vendorMatch }] }, select: { id: true, number: true, vendorId: true } }),
      accounting ? db.vendorBill.findMany({ ...limit, where: { OR: [{ number: match }, { vendorInvoiceNumber: match }, { vendorId: vendorMatch }] }, select: { id: true, number: true, vendorId: true, vendorInvoiceNumber: true } }) : [],
      accounting ? db.vendor.findMany({ ...limit, where: { name: match }, select: { id: true, name: true, kind: true } }) : [],
      db.item.findMany({ ...limit, where: { OR: [{ sku: match }, { name: match }, { brand: match }] }, select: { id: true, sku: true, name: true, brand: true } }),
      accounting ? db.journalEntry.findMany({ ...limit, where: { OR: [{ number: match }, { memo: match }] }, select: { id: true, number: true, memo: true } }) : [],
      accounting ? db.vendorCredit.findMany({ ...limit, where: { number: match }, select: { id: true, number: true, billId: true } }) : [],
      accounting ? db.payment.findMany({ ...limit, where: { number: match }, select: { id: true, number: true, billId: true } }) : [],
    ]);
    const vendorNames = new Map((await db.vendor.findMany({
      where: { id: { in: [...orders, ...bills].flatMap((r) => r.vendorId == null ? [] : [r.vendorId]) } },
      select: { id: true, name: true },
    })).map((v) => [v.id, v.name]));
    const vendorName = (id: number | null) => (id == null ? undefined : vendorNames.get(id)) ?? "Vendor not set";
    const groups: Record<string, SearchResult[]> = {
      purchaseOrders: orders.map((o) => ({ type: "purchaseOrder", id: o.id, title: o.number, subtitle: vendorName(o.vendorId), url: `/orders/${o.id}` })),
      items: items.map((i) => ({ type: "item", id: i.id, title: i.name, subtitle: [i.sku, i.brand].filter(Boolean).join(" · "), url: "/items" })),
    };
    if (accounting) Object.assign(groups, {
      bills: bills.map((b) => ({ type: "bill", id: b.id, title: b.number, subtitle: [vendorName(b.vendorId), b.vendorInvoiceNumber].filter(Boolean).join(" · "), url: `/bills/${b.id}` })),
      vendors: vendors.map((v) => ({ type: "vendor", id: v.id, title: v.name, subtitle: "Settings · Warehouses & vendors", url: "/settings" })),
      journalEntries: entries.map((e) => ({ type: "journalEntry", id: e.id, title: e.number, subtitle: e.memo ?? "Journal entry", url: `/reports?cat=accounting&tab=journal&q=${encodeURIComponent(e.number)}` })),
      credits: credits.map((c) => ({ type: "credit", id: c.id, title: c.number, subtitle: "Vendor credit · Open bill", url: `/bills/${c.billId}` })),
      payments: payments.map((p) => ({ type: "payment", id: p.id, title: p.number, subtitle: "Payment · Open bill", url: `/bills/${p.billId}` })),
    });
    return groups;
  });
}
