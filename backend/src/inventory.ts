import { Prisma } from "@prisma/client";
import { badRequest, conflict } from "./errors";
import type { MovementType } from "./domain";

export type Tx = Prisma.TransactionClient;

export type BalanceDelta = {
  onHandQty?: number;
  reservedQty?: number;
  incomingQty?: number;
};

export type BalanceOptions = {
  /**
   * Allow on-hand to fall below the reserved quantity.
   *
   * Only a shipment may do this, because it consumes the very reservation it
   * is drawing down. Anything else — a transfer, a write-off — must leave
   * reserved stock alone, or it takes units out from under a packed order.
   */
  allowReserved?: boolean;
};

/**
 * Balance rows are created lazily the first time a [product, warehouse] pair is
 * touched. Upsert rather than find-then-create so two concurrent callers cannot
 * both try to insert the same pair and trip the composite unique constraint.
 */
export async function getOrCreateBalance(
  tx: Tx,
  productId: number,
  warehouseId: number
) {
  return tx.inventoryBalance.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: { productId, warehouseId },
    update: {},
  });
}

/**
 * Apply a signed delta to a balance row.
 *
 * Two guarantees:
 *  - No component (onHand, reserved, incoming) may end up below zero. Clamping
 *    a negative figure would silently erase somebody else's reservation, so
 *    these throw instead.
 *  - The write is conditional on the row still holding the values we read, so a
 *    concurrent request cannot slip between the check and the update. A lost
 *    race is reported as a 409, not applied on stale numbers.
 */
export async function applyBalanceDelta(
  tx: Tx,
  productId: number,
  warehouseId: number,
  delta: BalanceDelta,
  context: string,
  options: BalanceOptions = {}
) {
  const balance = await getOrCreateBalance(tx, productId, warehouseId);

  const next = {
    onHandQty: balance.onHandQty + (delta.onHandQty ?? 0),
    reservedQty: balance.reservedQty + (delta.reservedQty ?? 0),
    incomingQty: balance.incomingQty + (delta.incomingQty ?? 0),
  };

  if (next.onHandQty < 0) {
    throw badRequest(
      `${context}: not enough on-hand stock (have ${balance.onHandQty}, need ${-(delta.onHandQty ?? 0)})`
    );
  }
  // Taking stock out without releasing a reservation would strand a packed
  // order with nothing to ship. Only a shipment is exempt, since it releases
  // the reservation in the same delta.
  if (
    !options.allowReserved &&
    (delta.onHandQty ?? 0) < 0 &&
    next.onHandQty < next.reservedQty
  ) {
    const available = balance.onHandQty - balance.reservedQty;
    throw badRequest(
      `${context}: only ${available} unit(s) are available — ${balance.reservedQty} of ${balance.onHandQty} are reserved for packed orders`
    );
  }
  if (next.reservedQty < 0) {
    throw badRequest(
      `${context}: cannot release ${-(delta.reservedQty ?? 0)} reserved units, only ${balance.reservedQty} are reserved`
    );
  }
  if (next.incomingQty < 0) {
    throw badRequest(
      `${context}: cannot release ${-(delta.incomingQty ?? 0)} incoming units, only ${balance.incomingQty} are incoming`
    );
  }

  // Pin only the columns this delta actually touches. Pinning all three would
  // make a receipt (incoming) and a shipment (on hand, reserved) on the same
  // SKU collide with a spurious 409 even though they do not overlap.
  const guard: Prisma.InventoryBalanceWhereInput = { id: balance.id };
  const data: Prisma.InventoryBalanceUpdateManyMutationInput = {};
  if (delta.onHandQty !== undefined) {
    guard.onHandQty = balance.onHandQty;
    data.onHandQty = next.onHandQty;
  }
  if (delta.reservedQty !== undefined) {
    guard.reservedQty = balance.reservedQty;
    data.reservedQty = next.reservedQty;
  }
  if (delta.incomingQty !== undefined) {
    guard.incomingQty = balance.incomingQty;
    data.incomingQty = next.incomingQty;
  }

  const written = await tx.inventoryBalance.updateMany({ where: guard, data });
  if (written.count === 0) {
    throw conflict(`${context}: stock changed while this request was running, please retry`);
  }

  return { ...balance, ...next };
}

/**
 * Reserve stock for a sales order line. Fails if availableQty is short, and the
 * write is conditional on the same values the check was made against.
 */
export async function reserveStock(
  tx: Tx,
  productId: number,
  warehouseId: number,
  quantity: number,
  context: string
) {
  const balance = await getOrCreateBalance(tx, productId, warehouseId);
  const available = balance.onHandQty - balance.reservedQty;
  if (available < quantity) {
    throw badRequest(
      `${context}: only ${available} available (on hand ${balance.onHandQty}, reserved ${balance.reservedQty}), need ${quantity}`
    );
  }

  const written = await tx.inventoryBalance.updateMany({
    where: { id: balance.id, onHandQty: balance.onHandQty, reservedQty: balance.reservedQty },
    data: { reservedQty: balance.reservedQty + quantity },
  });
  if (written.count === 0) {
    throw conflict(`${context}: stock changed while this request was running, please retry`);
  }

  return { ...balance, reservedQty: balance.reservedQty + quantity };
}

export async function recordMovement(
  tx: Tx,
  input: {
    productId: number;
    fromWarehouseId?: number | null;
    toWarehouseId?: number | null;
    quantity: number;
    movementType: MovementType;
    reason?: string | null;
    referenceType?: string | null;
    referenceId?: number | null;
    /// Cost of the goods that moved, from the FIFO layers they came out of.
    totalCostCents?: number;
    actor: string;
  }
) {
  return tx.inventoryMovement.create({
    data: {
      productId: input.productId,
      fromWarehouseId: input.fromWarehouseId ?? null,
      toWarehouseId: input.toWarehouseId ?? null,
      quantity: input.quantity,
      movementType: input.movementType,
      reason: input.reason ?? null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      totalCostCents: input.totalCostCents ?? 0,
      actor: input.actor,
    },
  });
}

/**
 * Move a document from one status to another, but only if it is still in the
 * status we read. Returns false when somebody else got there first, which is
 * what stops a double-click from shipping an order twice.
 */
export async function claimStatusTransition(
  updateMany: (args: {
    where: { id: number; status: string };
    data: { status: string };
  }) => Promise<{ count: number }>,
  id: number,
  from: string,
  to: string
): Promise<boolean> {
  const result = await updateMany({ where: { id, status: from }, data: { status: to } });
  return result.count === 1;
}

/** availableQty is always derived, never stored. */
export function withAvailable<T extends { onHandQty: number; reservedQty: number }>(
  balance: T
) {
  return { ...balance, availableQty: balance.onHandQty - balance.reservedQty };
}
