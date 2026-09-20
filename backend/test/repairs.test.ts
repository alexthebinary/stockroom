/**
 * Service and repair.
 *
 * The assertions that matter are about the LEDGER, not the workflow:
 *   - taking a customer's unit in posts NOTHING and moves no balance;
 *   - parts consumed hit Repair Parts Expense (5300), never COGS (5000);
 *   - warranty coverage is derived, and "unknown" is distinguishable from "no".
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { ACCOUNT } from "../src/accounts";
import { applyBalanceDelta } from "../src/inventory";
import { createLot } from "../src/costing";
import { consumeRepairPart, openRepair, REPAIR_STATUS, warrantyState } from "../src/repairs";
import { intakeForRepair, receiveSerials, SERIAL_STATUS } from "../src/serials";

let warehouseId: number;
let customerId: number;
let g1Id: number;
let partId: number;

beforeAll(async () => {
  await boot();
  warehouseId = (await prisma.warehouse.create({ data: { name: "Svc WH", code: "SVWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Repair Customer" } })).id;
  g1Id = (await prisma.product.create({
    data: { sku: "UT-G1-SVC", name: "Unitree G1", brand: "Unitree", trackingMode: "SERIAL" },
  })).id;
  partId = (await prisma.product.create({
    data: { sku: "PART-ACT-1", name: "Actuator", trackingMode: "NONE", defaultCostCents: 12_000 },
  })).id;
  await prisma.$transaction(async (tx) => {
    await createLot(tx, { productId: partId, warehouseId, quantity: 10, unitCostCents: 12_000, sourceType: "TEST" });
    await applyBalanceDelta(tx, partId, warehouseId, { onHandQty: 10 }, "seed parts");
  });
});

async function customerUnitInCustody(serial: string) {
  return prisma.$transaction((tx) =>
    intakeForRepair(tx, { productId: g1Id, serialNumber: serial, warehouseId, notes: "won't power on" })
  );
}

async function ledgerTotals() {
  const lines = await prisma.journalLine.findMany({ include: { account: true } });
  const by: Record<string, number> = {};
  for (const l of lines) {
    by[l.account.code] = (by[l.account.code] ?? 0) + l.debitCents - l.creditCents;
  }
  return by;
}

describe("repair intake posts nothing", () => {
  it("takes a customer unit into custody without touching the books", async () => {
    const before = await ledgerTotals();
    const beforeMovements = await prisma.inventoryMovement.count();

    const unit = await customerUnitInCustody("SVC-0001");

    expect(unit.lotId, "a customer's unit is not our asset").toBeNull();
    expect(unit.status).toBe(SERIAL_STATUS.RECEIVED_FOR_REPAIR);
    expect(await ledgerTotals()).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(beforeMovements);
  });

  it("refuses to open a repair against our OWN stock", async () => {
    // Owned stock has a lot. A repair is for someone else's unit.
    await prisma.$transaction(async (tx) => {
      await receiveSerials(tx, {
        productId: g1Id, warehouseId, unitCostCents: 1_000_000,
        serials: [{ serialNumber: "OURS-1" }], sourceType: "TEST",
      });
      await applyBalanceDelta(tx, g1Id, warehouseId, { onHandQty: 1 }, "seed owned");
    });
    const owned = await prisma.serialUnit.findFirstOrThrow({ where: { serialNumber: "OURS-1" } });

    await expect(
      prisma.$transaction((tx) =>
        openRepair(tx, {
          serialUnitId: owned.id, repairNumber: "RMA-BAD", billable: true, actor: "t@local",
        })
      )
    ).rejects.toThrow(/owned stock/i);
  });
});

describe("repair parts post to Repair Parts Expense, not COGS", () => {
  it("consumes a part and posts 5300 / 1200", async () => {
    const unit = await customerUnitInCustody("SVC-0002");
    const repair = await prisma.$transaction((tx) =>
      openRepair(tx, {
        serialUnitId: unit.id, repairNumber: "RMA-0002", customerId,
        billable: false, coverageNote: "in warranty, judged by tech", actor: "t@local",
      })
    );
    expect(repair.status).toBe(REPAIR_STATUS.OPEN);

    const before = await ledgerTotals();
    const line = await prisma.$transaction((tx) =>
      consumeRepairPart(tx, {
        repairOrderId: repair.id, productId: partId, warehouseId, quantity: 2, actor: "t@local",
      })
    );

    expect(line.totalCostCents).toBe(24_000);

    const after = await ledgerTotals();
    const dRepair = (after[ACCOUNT.REPAIR_PARTS] ?? 0) - (before[ACCOUNT.REPAIR_PARTS] ?? 0);
    const dInventory = (after[ACCOUNT.INVENTORY] ?? 0) - (before[ACCOUNT.INVENTORY] ?? 0);
    const dCogs = (after[ACCOUNT.COGS] ?? 0) - (before[ACCOUNT.COGS] ?? 0);

    expect(dRepair, "Repair Parts Expense must be debited").toBe(24_000);
    expect(dInventory, "Inventory must be credited").toBe(-24_000);
    expect(dCogs, "COGS must be untouched — no revenue is matched against a repair").toBe(0);

    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId: partId, warehouseId } });
    expect(bal.onHandQty).toBe(8);
  });
});

describe("warranty is derived, and unknown is not 'no'", () => {
  it("reports UNKNOWN when there is no start date or no policy", async () => {
    const unit = await customerUnitInCustody("SVC-0003");
    const noStart = await prisma.$transaction((tx) => warrantyState(tx, unit.id));
    expect(noStart.covered, "unknown must be null, never false").toBeNull();
    expect(noStart.reason).toMatch(/no warranty start date/i);

    await prisma.serialUnit.update({
      where: { id: unit.id }, data: { warrantyStartAt: new Date("2026-01-01") },
    });
    const noPolicy = await prisma.$transaction((tx) => warrantyState(tx, unit.id));
    expect(noPolicy.covered).toBeNull();
    expect(noPolicy.reason).toMatch(/no warranty policy/i);
  });

  it("derives coverage from the brand policy, and expires it on time", async () => {
    await prisma.warrantyPolicy.create({ data: { brand: "Unitree", durationMonths: 12 } });
    const unit = await customerUnitInCustody("SVC-0004");
    await prisma.serialUnit.update({
      where: { id: unit.id }, data: { warrantyStartAt: new Date("2026-01-01") },
    });

    const inside = await prisma.$transaction((tx) =>
      warrantyState(tx, unit.id, new Date("2026-06-01"))
    );
    expect(inside.covered).toBe(true);

    const outside = await prisma.$transaction((tx) =>
      warrantyState(tx, unit.id, new Date("2027-03-01"))
    );
    expect(outside.covered).toBe(false);
    expect(outside.reason).toMatch(/warranty ended 2027-01-01/);
  });
});
