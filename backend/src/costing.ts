import { prisma } from "./db";
import { badRequest, conflict } from "./errors";
import type { Tx } from "./inventory";

/**
 * Perpetual weighted average cost (client approved 2026-09-28; replaced FIFO).
 *
 * VALUE lives in one ProductCost row per product, across every warehouse: a
 * receipt adds its value and re-averages, an issue takes round(value × q / qty),
 * and the last units out take whatever value is left so the pool drains to 0.
 *
 * InventoryLot / LotConsumption are the PHYSICAL trail — which receipt, which
 * warehouse, which serial, drawn oldest-first — and each consumption records
 * its share of the pool cost. They no longer decide what anything cost.
 */

/**
 * POOL: the stock is new to the company (receipt, return, found stock) and its
 * value joins the average. CARRY: the stock is already in the pool and is only
 * changing warehouse (transfers), so the pool must not see it again.
 */
export type CostingMode = "POOL" | "CARRY";

export type LotSource = {
  sourceType: string;
  sourceId?: number | null;
};

/** Stock arriving: a new layer at the cost it was bought for. */
export async function createLot(
  tx: Tx,
  input: {
    productId: number;
    warehouseId: number;
    quantity: number;
    unitCostCents: number;
    receivedAt?: Date;
    costing: CostingMode;
  } & LotSource
) {
  if (input.quantity <= 0) throw badRequest("A cost layer needs a positive quantity");
  if (input.unitCostCents < 0) throw badRequest("A unit cost cannot be negative");

  // Before the lot exists: a pool opened lazily after the insert would count
  // this lot from the layers AND again from the increment.
  if (input.costing === "POOL") {
    await addToPool(tx, input.productId, input.quantity, input.quantity * input.unitCostCents);
  }

  return tx.inventoryLot.create({
    data: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      unitCostCents: input.unitCostCents,
      originalQty: input.quantity,
      remainingQty: input.quantity,
      receivedAt: input.receivedAt ?? new Date(),
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    },
  });
}

/**
 * The product's cost pool, created on first touch from what already exists:
 * open layers plus transfers in flight (their value lives on the transfer, not
 * in any lot). This IS the FIFO → average cutover, and it is idempotent.
 */
export async function ensureCostPool(tx: Tx, productId: number) {
  const existing = await tx.productCost.findUnique({ where: { productId } });
  if (existing) return existing;
  const [lots, transfers] = await Promise.all([
    tx.inventoryLot.findMany({
      where: { productId, remainingQty: { gt: 0 } },
      select: { remainingQty: true, unitCostCents: true },
    }),
    tx.stockTransfer.findMany({
      where: { productId, status: "IN_TRANSIT" },
      select: { quantity: true, costCents: true },
    }),
  ]);
  const qty =
    lots.reduce((s, l) => s + l.remainingQty, 0) + transfers.reduce((s, t) => s + t.quantity, 0);
  const valueCents =
    lots.reduce((s, l) => s + l.remainingQty * l.unitCostCents, 0) +
    transfers.reduce((s, t) => s + t.costCents, 0);
  return tx.productCost.upsert({
    where: { productId },
    create: { productId, qty, valueCents },
    update: {},
  });
}

/** Boot: open a pool for every product that has none. Returns how many were opened. */
export async function ensureCostPools() {
  const missing = await prisma.product.findMany({ where: { cost: null }, select: { id: true } });
  for (const { id } of missing) await prisma.$transaction((tx) => ensureCostPool(tx, id));
  return missing.length;
}

export async function addToPool(tx: Tx, productId: number, quantity: number, valueCents: number) {
  await ensureCostPool(tx, productId);
  await tx.productCost.update({
    where: { productId },
    data: {
      qty: { increment: quantity },
      valueCents: { increment: valueCents },
      version: { increment: 1 },
    },
  });
}

/** The cost of `quantity` units at the pool's average; the last units take whatever value remains. */
export function shareOfPool(pool: { qty: number; valueCents: number }, quantity: number) {
  if (quantity === pool.qty) return pool.valueCents;
  return Math.round((pool.valueCents * quantity) / pool.qty);
}

/** Take `quantity` units' worth out of the pool; returns what they cost. */
export async function takeFromPool(tx: Tx, productId: number, quantity: number, context: string) {
  const pool = await ensureCostPool(tx, productId);
  if (pool.qty < quantity) {
    throw badRequest(`${context}: only ${pool.qty} unit(s) are costed for this product, need ${quantity}.`);
  }
  const costCents = shareOfPool(pool, quantity);
  const written = await tx.productCost.updateMany({
    where: { productId, version: pool.version },
    data: { qty: pool.qty - quantity, valueCents: pool.valueCents - costCents, version: pool.version + 1 },
  });
  if (written.count === 0) {
    throw conflict(`${context}: the average cost changed while this request was running, please retry`);
  }
  return costCents;
}

/** What `quantity` would cost now, without taking it (transfers). */
export async function quotePoolCost(tx: Tx, productId: number, quantity: number) {
  const pool = await ensureCostPool(tx, productId);
  return pool.qty === 0 ? 0 : shareOfPool(pool, Math.min(quantity, pool.qty));
}

export async function averageUnitCostCents(tx: Tx, productId: number) {
  const pool = await ensureCostPool(tx, productId);
  return pool.qty > 0 ? Math.round(pool.valueCents / pool.qty) : null;
}

/**
 * Cost for stock arriving with no purchase behind it (adjust-in, found stock):
 * today's average, else the product's expected total cost of goods per unit.
 */
export async function arrivalUnitCostCents(
  tx: Tx,
  product: { id: number; costOfGoodsCents: number; supplierShippingCents: number }
) {
  return (
    (await averageUnitCostCents(tx, product.id)) ??
    product.costOfGoodsCents + product.supplierShippingCents
  );
}

/** Split a total over quantities by cumulative rounding, so the parts sum exactly. */
export function allocate(totalCents: number, quantities: number[]) {
  const all = quantities.reduce((s, q) => s + q, 0);
  let seen = 0;
  let given = 0;
  return quantities.map((q, i) => {
    seen += q;
    const upTo = i === quantities.length - 1 ? totalCents : Math.round((totalCents * seen) / all);
    const part = upTo - given;
    given = upTo;
    return part;
  });
}

export type ConsumptionSlice = {
  lotId: number;
  quantity: number;
  unitCostCents: number;
  costCents: number;
  /** The original receipt date, so a transfer can preserve FIFO age. */
  receivedAt: Date;
};

export type DrawInput = {
  productId: number;
  warehouseId: number;
  quantity: number;
  movementId?: number | null;
  context: string;
} & LotSource;

/**
 * Physical draw: take `quantity` from this warehouse's layers, oldest receipt
 * first (the pick order, not the cost rule). The returned cost is the layers'
 * RECEIPT cost — right only for CARRY (transfers); issues use `issueStock`.
 *
 * Refuses to draw more than the layers hold — the mirror of the quantity rule
 * that on-hand may never go negative.
 */
export async function drawLots(
  tx: Tx,
  input: DrawInput
): Promise<{ totalCostCents: number; slices: ConsumptionSlice[]; consumptionIds: number[] }> {
  if (input.quantity <= 0) throw badRequest("Cannot consume a non-positive quantity");

  const lots = await tx.inventoryLot.findMany({
    where: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      remainingQty: { gt: 0 },
    },
    // Oldest first: the physical pick order. Cost comes from the pool.
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });

  const available = lots.reduce((sum, lot) => sum + lot.remainingQty, 0);
  if (available < input.quantity) {
    throw badRequest(
      `${input.context}: only ${available} unit(s) are costed in this warehouse, need ${input.quantity}. ` +
        `Receive stock through a purchase order or an adjustment so it carries a cost.`
    );
  }

  const slices: ConsumptionSlice[] = [];
  const consumptionIds: number[] = [];
  let outstanding = input.quantity;
  let totalCostCents = 0;

  for (const lot of lots) {
    if (outstanding === 0) break;
    const take = Math.min(lot.remainingQty, outstanding);
    const costCents = take * lot.unitCostCents;

    // Conditional on the remaining quantity we read, so two concurrent issues
    // cannot both draw the same units from a layer.
    const written = await tx.inventoryLot.updateMany({
      where: { id: lot.id, remainingQty: lot.remainingQty },
      data: { remainingQty: lot.remainingQty - take },
    });
    if (written.count === 0) {
      // A lost optimistic race is retryable, so it is a 409 like every other
      // one in this codebase (inventory.ts, and the busy-database mapping in
      // http.ts). Reporting it as 400 told a retrying client not to retry.
      throw conflict(`${input.context}: cost layers changed while this request was running, please retry`);
    }

    const consumption = await tx.lotConsumption.create({
      data: {
        lotId: lot.id,
        quantity: take,
        unitCostCents: lot.unitCostCents,
        costCents,
        movementId: input.movementId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
      },
    });
    consumptionIds.push(consumption.id);

    slices.push({
      lotId: lot.id,
      quantity: take,
      unitCostCents: lot.unitCostCents,
      costCents,
      receivedAt: lot.receivedAt,
    });
    totalCostCents += costCents;
    outstanding -= take;
  }

  return { totalCostCents, slices, consumptionIds };
}

/**
 * Stock leaving the company (sale, write-off, count loss, repair): draw the
 * physical units, cost them at the pool's average, and price each consumption
 * row with its exact share so the trail sums to the COGS figure.
 */
export async function issueStock(tx: Tx, input: DrawInput) {
  // Open the pool BEFORE the draw, or a lazily-opened pool misses the units
  // this issue is about to take and then takes them again.
  await ensureCostPool(tx, input.productId);
  const drawn = await drawLots(tx, input);
  const totalCostCents = await takeFromPool(tx, input.productId, input.quantity, input.context);
  const slices = await priceConsumptions(tx, drawn.consumptionIds, drawn.slices, totalCostCents);
  return { totalCostCents, slices, consumptionIds: drawn.consumptionIds };
}

/** Spread an issue's pool cost over its consumption rows, exactly. */
export async function priceConsumptions(
  tx: Tx,
  consumptionIds: number[],
  slices: ConsumptionSlice[],
  totalCostCents: number
) {
  const parts = allocate(totalCostCents, slices.map((s) => s.quantity));
  const priced: ConsumptionSlice[] = [];
  for (const [i, id] of consumptionIds.entries()) {
    const costCents = parts[i];
    const unitCostCents = Math.round(costCents / slices[i].quantity);
    await tx.lotConsumption.update({ where: { id }, data: { costCents, unitCostCents } });
    priced.push({ ...slices[i], costCents, unitCostCents });
  }
  return priced;
}

/**
 * Link consumption rows to the movement they belong to.
 *
 * The movement cannot exist before the layers are consumed (its cost is the
 * result of that consumption), so the link is completed afterwards. Without
 * this the trail from a physical movement to the exact cost layers behind it
 * is severed.
 */
export async function attachConsumptionsToMovement(
  tx: Tx,
  consumptionIds: number[],
  movementId: number
) {
  if (consumptionIds.length === 0) return;
  await tx.lotConsumption.updateMany({
    where: { id: { in: consumptionIds } },
    data: { movementId },
  });
}
