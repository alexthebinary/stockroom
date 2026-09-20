/**
 * The invariant that justifies the whole serial design:
 *
 *   count(SerialUnit where status=IN_STOCK) == InventoryBalance.onHandQty
 *
 * ...for a serialized product, after an arbitrary mixed sequence. If this can
 * go false, the lot-per-unit design has failed and we are back to a second
 * source of truth maintained by convention.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { consumeSerials, intakeForRepair, receiveSerials, SERIAL_STATUS } from "../src/serials";
import { applyBalanceDelta } from "../src/inventory";

let warehouseId: number;
let otherWarehouseId: number;

beforeAll(async () => {
  await boot();
  const wh = await prisma.warehouse.create({ data: { name: "Serial WH", code: "SWH" } });
  warehouseId = wh.id;
  const wh2 = await prisma.warehouse.create({ data: { name: "Other WH", code: "OWH" } });
  otherWarehouseId = wh2.id;
});

async function serializedProduct(sku: string) {
  return prisma.product.create({
    data: { sku, name: `Serialized ${sku}`, brand: "Unitree", trackingMode: "SERIAL" },
  });
}

/** Receive serials AND move the balance, the way a real receipt does both. */
async function receive(productId: number, serials: string[], costCents: number) {
  return prisma.$transaction(async (tx) => {
    const units = await receiveSerials(tx, {
      productId, warehouseId, unitCostCents: costCents,
      serials: serials.map((s) => ({ serialNumber: s })),
      sourceType: "TEST",
    });
    await applyBalanceDelta(tx, productId, warehouseId,
      { onHandQty: serials.length }, "test receive");
    return units;
  });
}

async function onHand(productId: number) {
  const b = await prisma.inventoryBalance.findFirst({ where: { productId, warehouseId } });
  return b?.onHandQty ?? 0;
}

async function inStockSerials(productId: number) {
  return prisma.serialUnit.count({
    where: { productId, status: SERIAL_STATUS.IN_STOCK, warehouseId },
  });
}

async function lotRemaining(productId: number) {
  const lots = await prisma.inventoryLot.findMany({ where: { productId, warehouseId } });
  return lots.reduce((s, l) => s + l.remainingQty, 0);
}

describe("serialized stock holds its invariant", () => {
  it("receive creates one cost layer per unit", async () => {
    const p = await serializedProduct("UT-G1-EDU");
    await receive(p.id, ["G1-0001", "G1-0002", "G1-0003"], 1_200_000);

    const lots = await prisma.inventoryLot.findMany({ where: { productId: p.id } });
    expect(lots).toHaveLength(3);
    expect(lots.every((l) => l.originalQty === 1 && l.remainingQty === 1)).toBe(true);

    expect(await inStockSerials(p.id)).toBe(3);
    expect(await onHand(p.id)).toBe(3);
    expect(await lotRemaining(p.id)).toBe(3);
  });

  it("holds the invariant across a mixed receive / consume / custody sequence", async () => {
    const p = await serializedProduct("UT-GO2-PRO");
    await receive(p.id, ["GO2-01", "GO2-02", "GO2-03", "GO2-04"], 400_000);

    // Ship two named units — NOT the FIFO-oldest two, deliberately.
    await prisma.$transaction(async (tx) => {
      await consumeSerials(tx, {
        productId: p.id, warehouseId,
        serialNumbers: ["GO2-03", "GO2-01"],
        context: "test ship", sourceType: "TEST",
      });
      await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: -2 }, "test move");
    });

    expect(await inStockSerials(p.id)).toBe(2);
    expect(await onHand(p.id)).toBe(2);
    expect(await lotRemaining(p.id)).toBe(2);

    // A customer unit arrives for repair. It is NOT ours, so nothing about
    // owned stock may move.
    const beforeOnHand = await onHand(p.id);
    const beforeLots = await lotRemaining(p.id);
    await prisma.$transaction((tx) =>
      intakeForRepair(tx, {
        productId: p.id, serialNumber: "GO2-CUSTOMER-99",
        warehouseId, notes: "cracked shell",
      })
    );
    expect(await onHand(p.id), "custody must not change owned stock").toBe(beforeOnHand);
    expect(await lotRemaining(p.id)).toBe(beforeLots);

    const custody = await prisma.serialUnit.findFirstOrThrow({
      where: { serialNumber: "GO2-CUSTOMER-99" },
    });
    expect(custody.lotId, "a unit in custody must hold no cost layer").toBeNull();
    expect(custody.status).toBe(SERIAL_STATUS.RECEIVED_FOR_REPAIR);

    // THE INVARIANT, after everything above.
    expect(await inStockSerials(p.id)).toBe(await onHand(p.id));
    expect(await lotRemaining(p.id)).toBe(await onHand(p.id));
  });

  it("consumes the NAMED serial, not the FIFO-oldest one", async () => {
    // The whole reason consumeFifo cannot be reused. If this fails, a customer
    // holds one serial while our records claim another.
    const p = await serializedProduct("BL-X1C");
    await receive(p.id, ["OLDEST", "MIDDLE", "NEWEST"], 150_000);

    await prisma.$transaction(async (tx) => {
      await consumeSerials(tx, {
        productId: p.id, warehouseId, serialNumbers: ["NEWEST"],
        context: "pick newest", sourceType: "TEST",
      });
      await applyBalanceDelta(tx, p.id, warehouseId, { onHandQty: -1 }, "test move");
    });

    const gone = await prisma.serialUnit.findFirstOrThrow({
      where: { productId: p.id, serialNumber: "NEWEST" },
    });
    expect(gone.status).toBe(SERIAL_STATUS.SOLD);

    const still = await prisma.serialUnit.findMany({
      where: { productId: p.id, status: SERIAL_STATUS.IN_STOCK },
      select: { serialNumber: true },
    });
    expect(still.map((s) => s.serialNumber).sort()).toEqual(["MIDDLE", "OLDEST"]);
  });

  it("refuses a duplicate serial rather than merging it", async () => {
    const p = await serializedProduct("XAG-P100");
    await receive(p.id, ["XAG-1"], 900_000);
    await expect(receive(p.id, ["XAG-1"], 900_000)).rejects.toThrow(/already on file/i);
  });

  it("refuses a serial that is in another warehouse", async () => {
    const p = await serializedProduct("UT-A2");
    await receive(p.id, ["A2-1"], 300_000);
    await expect(
      prisma.$transaction((tx) =>
        consumeSerials(tx, {
          productId: p.id, warehouseId: otherWarehouseId,
          serialNumbers: ["A2-1"], context: "wrong wh", sourceType: "TEST",
        })
      )
    ).rejects.toThrow(/another warehouse/i);
  });

  it("two pickers cannot both take the same unit", async () => {
    const p = await serializedProduct("UT-B2");
    await receive(p.id, ["B2-1"], 250_000);

    const pick = () =>
      prisma.$transaction((tx) =>
        consumeSerials(tx, {
          productId: p.id, warehouseId, serialNumbers: ["B2-1"],
          context: "race", sourceType: "TEST",
        })
      );

    const results = await Promise.allSettled([pick(), pick()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await lotRemaining(p.id)).toBe(0);
  });
});
