/**
 * Serialized stock: one cost layer per physical unit.
 *
 * THE WHOLE DESIGN IN ONE LINE — a serialized product's `InventoryLot` holds
 * exactly one unit, and `SerialUnit.lotId` points at it. Nothing here invents a
 * second place that knows how much stock exists: `InventoryBalance.onHandQty`
 * is still `sum(remainingQty)` across layers, exactly as for anonymous stock.
 * "In-stock serial count == on-hand quantity" is therefore true by construction,
 * not by a reconciliation job comparing two counters that drift.
 *
 * 🔴 WHY A SEPARATE CONSUME PATH EXISTS. `consumeFifo` is quantity-driven and
 * oldest-layer-first. That is correct for anonymous stock and WRONG the moment a
 * specific unit matters — which, for warranty and RMA, is always. A technician
 * pulling a replacement Unitree G1 picks a serial off the shelf, not whichever
 * layer happens to be oldest. Left to `consumeFifo`, the system would pick some
 * unit, compute a correct cost, and record the WRONG serial against the
 * shipment: the customer holds serial X while our RMA lookup says Y went to
 * them. Silently wrong, and only discovered during a warranty claim.
 */
import type { Prisma } from "@prisma/client";
import { badRequest, conflict, notFound } from "./errors";
import { createLot, type LotSource } from "./costing";

export type Tx = Prisma.TransactionClient;

export const SERIAL_STATUS = {
  IN_STOCK: "IN_STOCK",
  SOLD: "SOLD",
  RECEIVED_FOR_REPAIR: "RECEIVED_FOR_REPAIR",
  IN_REPAIR: "IN_REPAIR",
  RETURNED_TO_CUSTOMER: "RETURNED_TO_CUSTOMER",
  REPLACED: "REPLACED",
  SENT_TO_VENDOR: "SENT_TO_VENDOR",
  SCRAPPED: "SCRAPPED",
} as const;

export async function isSerialized(tx: Tx, productId: number) {
  const p = await tx.product.findUnique({
    where: { id: productId },
    select: { trackingMode: true },
  });
  if (!p) throw notFound(`Product ${productId} not found`);
  return p.trackingMode === "SERIAL";
}

/**
 * Receive serialized units: one cost layer per serial.
 *
 * Every serial must be supplied. A serialized receipt with a bare quantity is
 * refused rather than guessed at, because a fabricated serial passes every
 * consistency check this system has and is wrong the one time it matters.
 */
export async function receiveSerials(
  tx: Tx,
  input: {
    productId: number;
    warehouseId: number;
    unitCostCents: number;
    serials: { serialNumber: string; boxSerial?: string | null }[];
    warrantyStartAt?: Date | null;
  } & LotSource
) {
  if (!input.serials.length) {
    throw badRequest("A serialized receipt needs at least one serial number");
  }
  const seen = new Set<string>();
  for (const s of input.serials) {
    const n = s.serialNumber.trim();
    if (!n) throw badRequest("A serial number cannot be blank");
    if (seen.has(n)) throw badRequest(`Serial ${n} was scanned twice in one receipt`);
    seen.add(n);
  }

  // A serial already on file for this product is a duplicate scan or a relabelled
  // unit — either way a human decision, not something to silently merge.
  const existing = await tx.serialUnit.findMany({
    where: { productId: input.productId, serialNumber: { in: [...seen] } },
    select: { serialNumber: true, status: true },
  });
  if (existing.length) {
    throw conflict(
      `Already on file for this product: ${existing.map((e) => `${e.serialNumber} (${e.status})`).join(", ")}`,
      { action: "review-duplicate-serials", serials: existing.map((e) => e.serialNumber) }
    );
  }

  const created = [];
  for (const s of input.serials) {
    // One layer, one unit. This is what makes the invariant structural.
    const lot = await createLot(tx, {
      productId: input.productId,
      warehouseId: input.warehouseId,
      quantity: 1,
      unitCostCents: input.unitCostCents,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    });
    created.push(
      await tx.serialUnit.create({
        data: {
          productId: input.productId,
          serialNumber: s.serialNumber.trim(),
          boxSerial: s.boxSerial?.trim() || null,
          lotId: lot.id,
          warehouseId: input.warehouseId,
          status: SERIAL_STATUS.IN_STOCK,
          warrantyStartAt: input.warrantyStartAt ?? null,
        },
      })
    );
  }
  return created;
}

/**
 * Consume named serials, bypassing FIFO ordering entirely.
 *
 * Cost still comes from each unit's own layer, so valuation is unchanged — what
 * changes is WHICH layer, and that it is chosen by the operator rather than by
 * receipt date.
 */
export async function consumeSerials(
  tx: Tx,
  input: {
    productId: number;
    warehouseId: number;
    serialNumbers: string[];
    movementId?: number | null;
    context: string;
    toStatus?: string;
  } & LotSource
) {
  if (!input.serialNumbers.length) {
    throw badRequest(`${input.context}: name the serials to consume`);
  }

  const units = await tx.serialUnit.findMany({
    where: {
      productId: input.productId,
      serialNumber: { in: input.serialNumbers },
    },
    include: { lot: true },
  });

  const found = new Set(units.map((u) => u.serialNumber));
  const missing = input.serialNumbers.filter((s) => !found.has(s));
  if (missing.length) {
    // Deliberately NOT costing.ts's "receive stock through a purchase order"
    // message: for a named serial the fix is never "receive more stock".
    throw notFound(`${input.context}: not on file for this product: ${missing.join(", ")}`);
  }

  let totalCostCents = 0;
  const consumptionIds: number[] = [];

  for (const unit of units) {
    if (unit.status !== SERIAL_STATUS.IN_STOCK) {
      throw conflict(`${input.context}: ${unit.serialNumber} is ${unit.status}, not in stock`);
    }
    if (unit.warehouseId !== input.warehouseId) {
      throw conflict(
        `${input.context}: ${unit.serialNumber} is in another warehouse — transfer it first`
      );
    }
    if (!unit.lot) {
      throw conflict(`${input.context}: ${unit.serialNumber} has no cost layer`);
    }

    // Same conditional-update idiom as consumeFifo (costing.ts:105-114), so two
    // technicians racing for one unit cannot both win it.
    const written = await tx.inventoryLot.updateMany({
      where: { id: unit.lot.id, remainingQty: 1 },
      data: { remainingQty: 0 },
    });
    if (written.count === 0) {
      throw conflict(
        `${input.context}: ${unit.serialNumber} was taken while this request was running, please retry`
      );
    }

    const consumption = await tx.lotConsumption.create({
      data: {
        lotId: unit.lot.id,
        quantity: 1,
        unitCostCents: unit.lot.unitCostCents,
        movementId: input.movementId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
      },
    });
    consumptionIds.push(consumption.id);
    totalCostCents += unit.lot.unitCostCents;

    await tx.serialUnit.update({
      where: { id: unit.id },
      data: { status: input.toStatus ?? SERIAL_STATUS.SOLD },
    });
  }

  return { totalCostCents, consumptionIds, units };
}

/**
 * Take a unit into custody for repair.
 *
 * 🔴 NOT an inventory movement. A customer's broken unit on our shelf is not our
 * asset — booking it as stock would debit Inventory for something we do not own.
 * So this writes no lot, no balance and no journal entry. It is a job queue with
 * a location field.
 */
export async function intakeForRepair(
  tx: Tx,
  input: { productId: number; serialNumber: string; warehouseId: number; notes?: string }
) {
  const unit = await tx.serialUnit.findUnique({
    where: {
      productId_serialNumber: {
        productId: input.productId,
        serialNumber: input.serialNumber,
      },
    },
  });
  if (!unit) {
    // A unit we never sold can still come in for service. Create it in custody
    // with no lot — owned-ness is exactly what lotId being null encodes.
    return tx.serialUnit.create({
      data: {
        productId: input.productId,
        serialNumber: input.serialNumber,
        warehouseId: input.warehouseId,
        status: SERIAL_STATUS.RECEIVED_FOR_REPAIR,
        lotId: null,
        notes: input.notes ?? null,
      },
    });
  }
  if (unit.lotId) {
    throw conflict(
      `${input.serialNumber} is currently owned stock (${unit.status}) — sell or ship it before taking it in for repair`
    );
  }
  return tx.serialUnit.update({
    where: { id: unit.id },
    data: {
      status: SERIAL_STATUS.RECEIVED_FOR_REPAIR,
      warehouseId: input.warehouseId,
      notes: input.notes ?? unit.notes,
    },
  });
}
