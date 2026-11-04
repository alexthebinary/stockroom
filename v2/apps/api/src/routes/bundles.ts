import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import type { Db, Tx } from "../db";
import { inTx } from "../db";
import { actorOf, idParam, notFound, parse } from "../http";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits } from "../stock";

type Reader = Db | Tx;
type Recipe = { id: number; sku: string; name: string; qty: number }[];

/**
 * Virtual bundles: an item made of one fixed recipe of component items. It owns
 * no stock, cost pool, lots or barcodes; how many can be made is computed from
 * the components, and shipping one takes the components out at average cost.
 */
const componentBody = z.object({ itemId: z.number().int().positive(), qty: z.number().int().positive() });
const createBody = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1),
  priceCents: z.number().int().min(0).nullish(),
  components: z.array(componentBody).min(1, "a bundle needs at least one component"),
});
const patchBody = z.object({
  name: z.string().trim().min(1).optional(),
  priceCents: z.number().int().min(0).nullable().optional(),
  components: z.array(componentBody).min(1, "a bundle needs at least one component").optional(),
});
const shipBody = z.object({
  warehouseId: z.number().int().positive(),
  qty: z.number().int().positive(),
  reference: z.string().trim().min(3, "give a reference — it goes on the record").max(300),
});

/** What is on hand of each component, by warehouse. */
async function onHandMap(db: Reader, itemIds: number[]) {
  const rows = await db.stockBalance.findMany({ where: { itemId: { in: itemIds } } });
  const map = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const byWh = map.get(r.itemId) ?? new Map<number, number>();
    byWh.set(r.warehouseId, r.onHand);
    map.set(r.itemId, byWh);
  }
  return map;
}

function makeable(recipe: { id: number; qty: number }[], onHand: Map<number, Map<number, number>>, warehouseId?: number) {
  let best = Infinity;
  for (const c of recipe) {
    const byWh = onHand.get(c.id);
    const have = warehouseId === undefined ? [...(byWh?.values() ?? [])].reduce((a, b) => a + b, 0) : (byWh?.get(warehouseId) ?? 0);
    best = Math.min(best, Math.floor(have / c.qty));
  }
  return best === Infinity ? 0 : best;
}

/** Add isBundle's recipe and availability (all warehouses and per warehouse) to a list of items. */
export async function withBundleInfo<T extends { id: number; isBundle: boolean }>(db: Reader, items: T[]) {
  const bundles = items.filter((i) => i.isBundle);
  if (bundles.length === 0) return items;
  const rows = await db.bundleComponent.findMany({ where: { bundleId: { in: bundles.map((b) => b.id) } }, include: { component: true }, orderBy: { id: "asc" } });
  const onHand = await onHandMap(db, [...new Set(rows.map((r) => r.componentId))]);
  const warehouses = await db.warehouse.findMany({ where: { isActive: true }, select: { id: true } });
  return items.map((item) => {
    if (!item.isBundle) return item;
    const components: Recipe = rows.filter((r) => r.bundleId === item.id).map((r) => ({ id: r.componentId, sku: r.component.sku, name: r.component.name, qty: r.qty }));
    const availableByWarehouse = Object.fromEntries(warehouses.map((w) => [w.id, makeable(components, onHand, w.id)]));
    return { ...item, components, available: makeable(components, onHand), availableByWarehouse };
  });
}

async function checkComponents(tx: Reader, components: { itemId: number; qty: number }[], bundleId?: number) {
  const ids = components.map((c) => c.itemId);
  if (new Set(ids).size !== ids.length) throw new DomainError("Each component can appear only once; add up the quantity instead", 400);
  const items = await tx.item.findMany({ where: { id: { in: ids } } });
  for (const id of ids) {
    const item = items.find((i) => i.id === id);
    if (!item) throw new DomainError(`Component item ${id} was not found`, 400);
    if (item.id === bundleId || item.isBundle) throw new DomainError(`${item.name} is itself a bundle; a bundle can only contain plain items`, 400);
    if (!item.isActive) throw new DomainError(`${item.name} is inactive and cannot be a component`, 400);
    if (item.trackingMode === "SERIAL") throw new DomainError(`${item.name} is serial-tracked; serial items cannot be bundle components yet`, 400);
  }
}

export function registerBundles(app: FastifyInstance, { db }: Deps) {
  app.post("/api/bundles", async (request) => {
    const body = parse(createBody, request.body);
    const actor = actorOf(request);
    const id = await inTx(db, async (tx) => {
      if (await tx.item.findUnique({ where: { sku: body.sku } })) throw new DomainError(`SKU ${body.sku} is already used`, 409);
      await checkComponents(tx, body.components);
      const bundle = await tx.item.create({
        data: {
          sku: body.sku,
          name: body.name,
          isBundle: true,
          trackingMode: "NONE",
          priceCents: body.priceCents ?? null,
          components: { create: body.components.map((c) => ({ componentId: c.itemId, qty: c.qty })) },
        },
      });
      await audit(tx, actor, "bundle.created", "Item", bundle.id, { sku: body.sku, components: body.components });
      return bundle.id;
    });
    return bundleDetail(db, id);
  });

  app.patch("/api/bundles/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(patchBody, request.body);
    const actor = actorOf(request);
    await inTx(db, async (tx) => {
      const bundle = await tx.item.findUnique({ where: { id } });
      if (!bundle || !bundle.isBundle) throw notFound("Bundle");
      if (body.components) {
        await checkComponents(tx, body.components, id);
        await tx.bundleComponent.deleteMany({ where: { bundleId: id } });
        await tx.bundleComponent.createMany({ data: body.components.map((c) => ({ bundleId: id, componentId: c.itemId, qty: c.qty })) });
      }
      await tx.item.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.priceCents !== undefined ? { priceCents: body.priceCents } : {}) } });
      await audit(tx, actor, "bundle.updated", "Item", id, body);
    });
    return bundleDetail(db, id);
  });

  app.get("/api/bundles/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    return bundleDetail(db, id);
  });

  app.post("/api/bundles/:id/ship", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(shipBody, request.body);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const bundle = await tx.item.findUnique({ where: { id }, include: { components: { include: { component: true }, orderBy: { id: "asc" } } } });
      if (!bundle || !bundle.isBundle) throw notFound("Bundle");
      if (bundle.components.length === 0) throw new DomainError(`${bundle.name} has no recipe`, 400);
      const warehouse = await tx.warehouse.findUnique({ where: { id: body.warehouseId } });
      if (!warehouse) throw new DomainError("That warehouse was not found", 400);
      for (const c of bundle.components) {
        const need = c.qty * body.qty;
        const balance = await tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: c.componentId, warehouseId: body.warehouseId } } });
        const have = balance ? balance.onHand - balance.reserved : 0;
        if (have < need) throw new DomainError(`Not enough ${c.component.name} (${c.component.sku}): shipping ${body.qty} needs ${need}, ${have} available at ${warehouse.code}`, 400);
      }
      const docNumber = await nextNumber(tx, "WH_OUT");
      const counter = { type: "ADJUSTMENT" as const, id: 0 };
      const issued: { itemId: number; sku: string; name: string; qty: number; valueCents: number }[] = [];
      for (const c of bundle.components) {
        const qty = c.qty * body.qty;
        const valueCents = await issueUnits({ tx, actor }, { itemId: c.componentId, warehouseId: body.warehouseId, qty, docNumber, counter });
        issued.push({ itemId: c.componentId, sku: c.component.sku, name: c.component.name, qty, valueCents });
      }
      const total = issued.reduce((s, l) => s + l.valueCents, 0);
      await postEntry(tx, {
        event: "BUNDLE_SHIPPED",
        date: new Date(),
        sourceType: "BUNDLE_SHIP",
        sourceId: bundle.id,
        actor,
        memo: `${docNumber}: ${bundle.sku} x${body.qty} — ${body.reference}`,
        lines: issued.flatMap((l) => [
          { role: "cogs" as const, amountCents: l.valueCents, itemId: l.itemId },
          { role: "inventoryOnHand" as const, amountCents: l.valueCents, itemId: l.itemId },
        ]),
      });
      await audit(tx, actor, "bundle.shipped", "Item", bundle.id, { docNumber, warehouseId: body.warehouseId, qty: body.qty, valueCents: total, reference: body.reference });
      return { docNumber, qty: body.qty, valueCents: total, components: issued };
    });
  });
}

async function bundleDetail(db: Reader, id: number) {
  const item = await db.item.findUnique({ where: { id } });
  if (!item || !item.isBundle) throw notFound("Bundle");
  const [full] = (await withBundleInfo(db, [item])) as (typeof item & { components: Recipe; available: number; availableByWarehouse: Record<number, number> })[];
  const warehouses = await db.warehouse.findMany({ where: { isActive: true }, orderBy: { id: "asc" } });
  return { ...full!, warehouses: warehouses.map((w) => ({ warehouseId: w.id, code: w.code, name: w.name, available: full!.availableByWarehouse[w.id] ?? 0 })) };
}
