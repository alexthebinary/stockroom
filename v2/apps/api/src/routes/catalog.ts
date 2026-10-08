import { DomainError, parseCsv, parseUsd } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { addBarcode, lookupCode } from "../catalog";
import { inTx } from "../db";
import { actorOf, idParam, notFound, parse } from "../http";

const JOBS = ["CLERK", "ACCOUNTING", "ADMIN"] as const;

const profileBody = z.object({ name: z.string().trim().min(1).max(60), job: z.enum(JOBS) });
const warehouseBody = z.object({ code: z.string().trim().min(1).max(12).toUpperCase(), name: z.string().trim().min(1) });
const vendorBody = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(["SUPPLIER", "CARRIER"]).default("SUPPLIER"),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});
const itemBody = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1),
  trackingMode: z.enum(["NONE", "SERIAL"]).default("NONE"),
  condition: z.enum(["NEW", "OPEN_BOX", "REFURBISHED", "DAMAGED"]).default("NEW"),
  conditionOfId: z.number().int().positive().nullish(),
  defaultVendorId: z.number().int().positive().nullish(),
  lastCostCents: z.number().int().min(0).default(0),
  barcodes: z.array(z.object({ raw: z.string().trim().min(1), packQty: z.number().int().positive().default(1) })).default([]),
  vendorItems: z
    .array(z.object({ vendorId: z.number().int().positive(), vendorSku: z.string().trim().min(1), lastCostCents: z.number().int().min(0).nullish() }))
    .default([]),
});

export function registerCatalog(app: FastifyInstance, { db }: Deps) {
  // ── Profiles ("who's working") ──
  app.get("/api/profiles", async () => db.profile.findMany({ where: { isActive: true }, orderBy: { id: "asc" } }));
  app.post("/api/profiles", async (request) => {
    const body = parse(profileBody, request.body);
    return db.profile.create({ data: body });
  });
  app.put("/api/profiles/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(profileBody.partial().extend({ isActive: z.boolean().optional() }), request.body);
    return db.profile.update({ where: { id }, data: body });
  });

  // ── Warehouses ──
  app.get("/api/warehouses", async () => db.warehouse.findMany({ where: { isActive: true }, orderBy: { id: "asc" } }));
  app.post("/api/warehouses", async (request) => db.warehouse.create({ data: parse(warehouseBody, request.body) }));
  app.put("/api/warehouses/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    return db.warehouse.update({ where: { id }, data: parse(warehouseBody.partial().extend({ isActive: z.boolean().optional() }), request.body) });
  });

  // ── Vendors ──
  app.get("/api/vendors", async (request) => {
    const { kind } = parse(z.object({ kind: z.enum(["SUPPLIER", "CARRIER"]).optional() }), request.query);
    return db.vendor.findMany({ where: { isActive: true, ...(kind ? { kind } : {}) }, orderBy: { name: "asc" } });
  });
  app.post("/api/vendors", async (request) => db.vendor.create({ data: parse(vendorBody, request.body) }));
  app.put("/api/vendors/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    return db.vendor.update({ where: { id }, data: parse(vendorBody.partial().extend({ isActive: z.boolean().optional() }), request.body) });
  });

  // ── Items ──
  app.get("/api/items", async (request) => {
    const { search } = parse(z.object({ search: z.string().trim().optional() }), request.query);
    return db.item.findMany({
      where: {
        isActive: true,
        ...(search
          ? { OR: [{ sku: { contains: search, mode: "insensitive" } }, { name: { contains: search, mode: "insensitive" } }, { barcodes: { some: { raw: { contains: search } } } }] }
          : {}),
      },
      include: { barcodes: true },
      orderBy: { sku: "asc" },
      take: 200,
    });
  });
  app.get("/api/items/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const item = await db.item.findUnique({ where: { id }, include: { barcodes: true, vendorItems: { include: { vendor: true } }, variants: true, conditionOf: true } });
    if (!item) throw notFound("Item");
    const [balances, pool] = await Promise.all([db.stockBalance.findMany({ where: { itemId: id } }), db.costPool.findUnique({ where: { itemId: id } })]);
    return { ...item, balances, pool };
  });
  app.post("/api/items", async (request) => {
    const body = parse(itemBody, request.body);
    return inTx(db, async (tx) => createItem(tx, body));
  });
  app.put("/api/items/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(itemBody.omit({ barcodes: true, vendorItems: true }).partial().extend({ isActive: z.boolean().optional() }), request.body);
    return db.item.update({ where: { id }, data: body });
  });
  /** Teach an item a barcode — the mapping step for an unknown scan. */
  app.post("/api/items/:id/barcodes", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ raw: z.string().trim().min(1), packQty: z.number().int().positive().default(1) }), request.body);
    return inTx(db, async (tx) => {
      const barcode = await addBarcode(tx, id, body.raw, body.packQty);
      await audit(tx, actorOf(request), "barcode.learned", "Item", id, { raw: body.raw });
      return barcode;
    });
  });

  app.get("/api/lookup", async (request) => {
    const { code, vendorId } = parse(z.object({ code: z.string().min(1), vendorId: z.coerce.number().int().positive().optional() }), request.query);
    const match = await lookupCode(db, code, vendorId);
    if (!match) return { match: null };
    const item = await db.item.findUnique({ where: { id: match.itemId } });
    return { match: { ...match, item } };
  });

  // ── CSV import (setup wizard steps 5 and 6) ──
  app.post("/api/import/:kind", async (request) => {
    const { kind } = parse(z.object({ kind: z.enum(["vendors", "items"]) }), request.params);
    const { csv, commit } = parse(z.object({ csv: z.string(), commit: z.boolean().default(false) }), request.body);
    const rows = parseCsv(csv);
    if (rows.length === 0) throw new DomainError("The file has a header row but no data rows", 400);
    const vendors = await db.vendor.findMany();
    const results = rows.map((row, index) => {
      try {
        return { row: index + 2, ok: true as const, data: kind === "vendors" ? vendorFromCsv(row) : itemFromCsv(row, vendors) };
      } catch (error) {
        return { row: index + 2, ok: false as const, error: (error as Error).message };
      }
    });
    if (!commit || results.some((r) => !r.ok)) return { commit: false, results };
    await inTx(db, async (tx) => {
      for (const r of results) {
        if (!r.ok) continue;
        if (kind === "vendors") await tx.vendor.create({ data: r.data as z.infer<typeof vendorBody> });
        else await createItem(tx, r.data as z.infer<typeof itemBody>);
      }
    });
    return { commit: true, results };
  });
}

export async function createItem(tx: Parameters<typeof addBarcode>[0], body: z.infer<typeof itemBody> & { isSample?: boolean }) {
  const { barcodes, vendorItems, ...fields } = body;
  const item = await tx.item.create({ data: fields });
  for (const b of barcodes) {
    try {
      await addBarcode(tx, item.id, b.raw, b.packQty);
    } catch {
      throw new DomainError(`Barcode ${b.raw} already belongs to another item`, 409);
    }
  }
  for (const v of vendorItems) await tx.vendorItem.create({ data: { ...v, itemId: item.id } });
  return item;
}

function vendorFromCsv(row: Record<string, string>) {
  return parse(vendorBody, {
    name: row.name,
    kind: (row.kind || "SUPPLIER").toUpperCase(),
    email: row.email || undefined,
    phone: row.phone || undefined,
    address: row.address || undefined,
    paymentTermsDays: row.terms_days ? Number(row.terms_days) : 30,
  });
}

function itemFromCsv(row: Record<string, string>, vendors: { id: number; name: string }[]) {
  const vendor = row.vendor ? vendors.find((v) => v.name.toLowerCase() === row.vendor!.toLowerCase()) : undefined;
  if (row.vendor && !vendor) throw new Error(`No vendor called "${row.vendor}" — import vendors first`);
  const cost = row.cost ? parseUsd(row.cost) : 0;
  if (cost == null) throw new Error(`"${row.cost}" is not a dollar amount`);
  return parse(itemBody, {
    sku: row.sku,
    name: row.name,
    trackingMode: (row.tracking || "NONE").toUpperCase() === "SERIAL" ? "SERIAL" : "NONE",
    defaultVendorId: vendor?.id,
    lastCostCents: cost,
    barcodes: row.barcode ? [{ raw: row.barcode, packQty: row.pack_qty ? Number(row.pack_qty) : 1 }] : [],
    vendorItems: vendor && row.vendor_sku ? [{ vendorId: vendor.id, vendorSku: row.vendor_sku, lastCostCents: cost }] : [],
  });
}
