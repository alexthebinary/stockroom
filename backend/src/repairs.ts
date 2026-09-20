/**
 * Service and repair.
 *
 * THE LEDGER RULE THAT SHAPES THIS FILE: a customer's unit in for repair is not
 * our asset, so taking it in moves no balance and posts no entry. Only two
 * things here reach the books, and neither is COGS:
 *
 *   parts consumed  ->  Dr Repair Parts Expense (5300)  Cr Inventory (1200)
 *   replacement out ->  Dr Warranty Expense     (5400)  Cr Inventory (1200)
 *
 * Folding either into Cost of Goods Sold would understate gross margin in every
 * period containing a repair, because there is no revenue matched against them.
 */
import type { Prisma } from "@prisma/client";
import { TRANSACTION_TYPE } from "./accounts";
import { consumeFifo } from "./costing";
import { badRequest, conflict, notFound } from "./errors";
import { applyBalanceDelta, recordMovement } from "./inventory";
import { postSimple } from "./ledger";
import { consumeSerials, SERIAL_STATUS } from "./serials";

export type Tx = Prisma.TransactionClient;

export const REPAIR_STATUS = {
  OPEN: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_PARTS: "AWAITING_PARTS",
  COMPLETED: "COMPLETED",
  RETURNED: "RETURNED",
  REPLACED: "REPLACED",
  SCRAPPED: "SCRAPPED",
} as const;

/**
 * Is this unit inside its warranty window?
 *
 * DERIVED, never stored — same rule the codebase already applies to
 * `availableQty` ("always derived, never stored") and to `amountPaidCents`,
 * which is recomputed so a voided payment stops counting the moment it is
 * voided. A stored warranty flag or a fixed end date drifts the instant terms
 * change or time simply passes.
 *
 * Returns `null` when it cannot be determined — no start date or no policy.
 * ⚠️ `null` is NOT "out of warranty". The caller must present it as unknown and
 * let a human decide; silently treating unknown as uncovered bills a customer
 * for something that may well be covered.
 */
export async function warrantyState(
  tx: Tx,
  serialUnitId: number,
  now = new Date()
): Promise<{ covered: boolean | null; reason: string; endsAt: Date | null }> {
  const unit = await tx.serialUnit.findUnique({
    where: { id: serialUnitId },
    include: { product: true },
  });
  if (!unit) throw notFound("Serial unit not found");
  if (!unit.warrantyStartAt) {
    return { covered: null, reason: "no warranty start date recorded for this unit", endsAt: null };
  }

  // A product-specific policy beats a brand one.
  const policy =
    (await tx.warrantyPolicy.findFirst({ where: { productId: unit.productId } })) ??
    (unit.product.brand
      ? await tx.warrantyPolicy.findFirst({ where: { brand: unit.product.brand, productId: null } })
      : null);
  if (!policy) {
    return {
      covered: null,
      reason: `no warranty policy on file for ${unit.product.brand ?? "this product"}`,
      endsAt: null,
    };
  }

  const endsAt = new Date(unit.warrantyStartAt);
  endsAt.setMonth(endsAt.getMonth() + policy.durationMonths);
  const covered = now <= endsAt;
  return {
    covered,
    reason: covered
      ? `within ${policy.durationMonths} months of ${unit.warrantyStartAt.toISOString().slice(0, 10)}`
      : `warranty ended ${endsAt.toISOString().slice(0, 10)}`,
    endsAt,
  };
}

/** Open a repair against a unit already in custody. No ledger effect. */
export async function openRepair(
  tx: Tx,
  input: {
    serialUnitId: number;
    repairNumber: string;
    customerId?: number | null;
    faultReported?: string;
    billable: boolean;
    coverageNote?: string;
    actor: string;
  }
) {
  const unit = await tx.serialUnit.findUnique({ where: { id: input.serialUnitId } });
  if (!unit) throw notFound("Serial unit not found");
  if (unit.lotId) {
    throw conflict(
      `${unit.serialNumber} is owned stock — a repair is for a customer's unit, not ours`
    );
  }
  if (unit.status !== SERIAL_STATUS.RECEIVED_FOR_REPAIR) {
    throw conflict(`${unit.serialNumber} is ${unit.status}, not received for repair`);
  }

  const repair = await tx.repairOrder.create({
    data: {
      repairNumber: input.repairNumber,
      serialUnitId: input.serialUnitId,
      customerId: input.customerId ?? null,
      faultReported: input.faultReported ?? null,
      billable: input.billable,
      coverageNote: input.coverageNote ?? null,
      actor: input.actor,
      status: REPAIR_STATUS.OPEN,
    },
  });
  await tx.serialUnit.update({
    where: { id: input.serialUnitId },
    data: { status: SERIAL_STATUS.IN_REPAIR },
  });
  return repair;
}

/**
 * Pull a part from our own stock onto a repair.
 *
 * Reuses the ordinary pipeline unchanged — the only difference from a shipment
 * is the account it posts to.
 */
export async function consumeRepairPart(
  tx: Tx,
  input: {
    repairOrderId: number;
    productId: number;
    warehouseId: number;
    quantity: number;
    serialNumbers?: string[];
    actor: string;
  }
) {
  if (input.quantity <= 0) throw badRequest("A repair part needs a positive quantity");
  const repair = await tx.repairOrder.findUnique({ where: { id: input.repairOrderId } });
  if (!repair) throw notFound("Repair order not found");
  if ([REPAIR_STATUS.RETURNED, REPAIR_STATUS.REPLACED, REPAIR_STATUS.SCRAPPED].includes(
      repair.status as never)) {
    throw conflict(`Repair ${repair.repairNumber} is ${repair.status} — reopen it before adding parts`);
  }

  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (!product) throw notFound(`Product ${input.productId} not found`);

  const line = await tx.repairPartLine.create({
    data: {
      repairOrderId: input.repairOrderId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      quantity: input.quantity,
      serialNumbers: input.serialNumbers?.join(",") ?? null,
    },
  });

  await applyBalanceDelta(
    tx, input.productId, input.warehouseId,
    { onHandQty: -input.quantity },
    `Cannot pull ${product.sku} for repair ${repair.repairNumber}`
  );

  // Same serial/anonymous split as shipping: a serialized part must be named.
  let totalCostCents: number;
  if (product.trackingMode === "SERIAL") {
    const named = input.serialNumbers ?? [];
    if (named.length !== input.quantity) {
      throw badRequest(
        `${product.sku} is serial-tracked — name the ${input.quantity} unit(s) used (${named.length} given)`,
        { action: "scan-serials", productId: input.productId, quantity: input.quantity }
      );
    }
    const consumed = await consumeSerials(tx, {
      productId: input.productId, warehouseId: input.warehouseId,
      serialNumbers: named, sourceType: "REPAIR_ORDER", sourceId: input.repairOrderId,
      context: `Cannot pull ${product.sku} for repair ${repair.repairNumber}`,
      toStatus: SERIAL_STATUS.SCRAPPED,
    });
    totalCostCents = consumed.totalCostCents;
  } else {
    const consumed = await consumeFifo(tx, {
      productId: input.productId, warehouseId: input.warehouseId,
      quantity: input.quantity, sourceType: "REPAIR_ORDER", sourceId: input.repairOrderId,
      context: `Cannot cost ${product.sku} for repair ${repair.repairNumber}`,
    });
    totalCostCents = consumed.totalCostCents;
  }

  await recordMovement(tx, {
    productId: input.productId,
    fromWarehouseId: input.warehouseId,
    quantity: input.quantity,
    movementType: "REPAIR_CONSUMPTION",
    reason: `Parts for ${repair.repairNumber}`,
    referenceType: "REPAIR_ORDER",
    referenceId: input.repairOrderId,
    totalCostCents,
    actor: input.actor,
  });

  // Dr Repair Parts Expense / Cr Inventory — deliberately NOT COGS.
  await postSimple(tx, {
    transactionType: TRANSACTION_TYPE.REPAIR_PARTS_CONSUMPTION,
    amountCents: totalCostCents,
    memo: `Parts for ${repair.repairNumber}`,
    referenceType: "REPAIR_ORDER",
    referenceId: input.repairOrderId,
    actor: input.actor,
    productId: input.productId,
    creditWarehouseId: input.warehouseId,
  });

  return tx.repairPartLine.update({
    where: { id: line.id },
    data: { totalCostCents },
  });
}
