import { badRequest } from "./errors";
import type { Tx } from "./inventory";

/**
 * FIFO cost layers.
 *
 * A quantity balance cannot answer "what did this cost". Every receipt of
 * stock creates a layer with a unit cost and a remaining quantity; every issue
 * consumes the oldest layer first and records exactly which layers it drew
 * from. That consumption trail is the audit behind every COGS figure.
 */

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
  } & LotSource
) {
  if (input.quantity <= 0) throw badRequest("A cost layer needs a positive quantity");
  if (input.unitCostCents < 0) throw badRequest("A unit cost cannot be negative");

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

export type ConsumptionSlice = {
  lotId: number;
  quantity: number;
  unitCostCents: number;
  costCents: number;
  /** The original receipt date, so a transfer can preserve FIFO age. */
  receivedAt: Date;
};

/**
 * Stock leaving: draw `quantity` from the oldest layers first.
 *
 * Returns the total cost and the per-layer breakdown. Refuses to consume more
 * than the layers hold — which is the costing-side mirror of the quantity rule
 * that on-hand may never go negative. If the two ever disagree, this throws
 * rather than inventing a cost.
 */
export async function consumeFifo(
  tx: Tx,
  input: {
    productId: number;
    warehouseId: number;
    quantity: number;
    movementId?: number | null;
    context: string;
  } & LotSource
): Promise<{ totalCostCents: number; slices: ConsumptionSlice[]; consumptionIds: number[] }> {
  if (input.quantity <= 0) throw badRequest("Cannot consume a non-positive quantity");

  const lots = await tx.inventoryLot.findMany({
    where: {
      productId: input.productId,
      warehouseId: input.warehouseId,
      remainingQty: { gt: 0 },
    },
    // Oldest first — this ordering IS the FIFO rule.
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
      throw badRequest(`${input.context}: cost layers changed while this request was running, please retry`);
    }

    const consumption = await tx.lotConsumption.create({
      data: {
        lotId: lot.id,
        quantity: take,
        unitCostCents: lot.unitCostCents,
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

/**
 * Move stock between warehouses without changing what it cost: consume the
 * source layers, then recreate them at the destination at the same unit costs.
 * Averaging here would quietly destroy FIFO ordering.
 */
export async function transferLots(
  tx: Tx,
  input: {
    productId: number;
    fromWarehouseId: number;
    toWarehouseId: number;
    quantity: number;
    context: string;
  } & LotSource
) {
  const consumed = await consumeFifo(tx, {
    productId: input.productId,
    warehouseId: input.fromWarehouseId,
    quantity: input.quantity,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    context: input.context,
  });

  for (const slice of consumed.slices) {
    await createLot(tx, {
      productId: input.productId,
      warehouseId: input.toWarehouseId,
      quantity: slice.quantity,
      unitCostCents: slice.unitCostCents,
      // Carry the ORIGINAL receipt date across. Stamping "now" would make old
      // stock look newest at the destination and invert FIFO for everything
      // already sitting there.
      receivedAt: slice.receivedAt,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
  }

  return consumed;
}

/** Current stock value for a [product, warehouse], straight from the layers. */
export async function valueOnHand(tx: Tx, productId: number, warehouseId?: number) {
  const lots = await tx.inventoryLot.findMany({
    where: { productId, ...(warehouseId ? { warehouseId } : {}), remainingQty: { gt: 0 } },
  });
  return lots.reduce((sum, lot) => sum + lot.remainingQty * lot.unitCostCents, 0);
}
