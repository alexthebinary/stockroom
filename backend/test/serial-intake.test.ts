/**
 * Automated OCR serial capture. Policy: everything commits; humans sweep
 * exceptions afterwards. The tests therefore assert that the line KEEPS MOVING
 * in every degraded case, and that each one is still findable later.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import {
  correctSerial, decideIntake, formatCheck, normaliseSerial,
  repairByConfusion, reviewQueue, SERIAL_SOURCE,
} from "../src/serial_intake";
import { receiveSerials } from "../src/serials";
import { applyBalanceDelta } from "../src/inventory";

let warehouseId: number;
let unitreeId: number;

beforeAll(async () => {
  await boot();
  warehouseId = (await prisma.warehouse.create({ data: { name: "OCR WH", code: "OWH2" } })).id;
  unitreeId = (await prisma.product.create({
    data: { sku: "UT-OCR-1", name: "Unitree Go2", brand: "Unitree", trackingMode: "SERIAL" },
  })).id;
});

describe("the intake ladder is deterministic", () => {
  it("normalises whitespace, case and separators", () => {
    expect(normaliseSerial(" ut-123 456 ")).toBe("UT123456");
  });

  it("commits unflagged only when two readers agree", () => {
    const d = decideIntake({ brand: "Unitree", ocrText: "UT123456", barcode: "UT123456" });
    expect(d.source).toBe(SERIAL_SOURCE.OCR_CORROBORATED);
    expect(d.needsReview).toBe(false);
    expect(d.quarantine).toBe(false);
  });

  it("prefers the barcode over OCR, and flags the disagreement", () => {
    const d = decideIntake({ brand: "Unitree", ocrText: "UT123455", barcode: "UT123456" });
    expect(d.serial).toBe("UT123456");
    expect(d.source).toBe(SERIAL_SOURCE.BARCODE);
    expect(d.needsReview, "a disagreement must be visible later").toBe(true);
    expect(d.quarantine, "it still commits — the unit is physically here").toBe(false);
  });

  it("auto-corrects a single OCR confusion and says so", () => {
    // "UTO12345" — the O is almost certainly a zero.
    const d = decideIntake({ brand: "Unitree", ocrText: "UTO12345" });
    expect(d.serial).toBe("UT012345");
    expect(d.needsReview).toBe(true);
    expect(d.reviewReason).toMatch(/auto-corrected/i);
    expect(d.quarantine).toBe(false);
  });

  it("commits an unrecognisable format anyway, flagged — a smudge must not stop a delivery", () => {
    const d = decideIntake({ brand: "Unitree", ocrText: "???" });
    expect(d.serial).toBe("???");
    expect(d.needsReview).toBe(true);
    expect(d.quarantine).toBe(false);
  });

  it("escalates ONLY when nothing legible was read", () => {
    const d = decideIntake({ brand: "Unitree", ocrText: "" });
    expect(d.quarantine, "this is the high-level decision a human is for").toBe(true);
  });

  it("low confidence flags but never blocks", () => {
    const d = decideIntake({ brand: "Unitree", ocrText: "UT999888", ocrConfidence: 0.42 });
    expect(d.serial).toBe("UT999888");
    expect(d.needsReview).toBe(true);
    expect(d.quarantine).toBe(false);
  });

  it("an unknown brand has no pattern, and that is not a failure", () => {
    // Absence of a rule must never read as a failed rule.
    const fmt = formatCheck("SomeNewBrand", "WHATEVER-1");
    expect(fmt.known).toBe(false);
    expect(fmt.ok).toBe(true);
    expect(repairByConfusion("SomeNewBrand", "WHATEVER-1")).toBeNull();
  });
});

describe("a misread is a data fix, not a lost unit", () => {
  it("corrects the serial while keeping the lot, cost and history", async () => {
    await prisma.$transaction(async (tx) => {
      await receiveSerials(tx, {
        productId: unitreeId, warehouseId, unitCostCents: 500_000,
        serials: [{ serialNumber: "UT000111" }], sourceType: "TEST",
      });
      await applyBalanceDelta(tx, unitreeId, warehouseId, { onHandQty: 1 }, "seed");
    });
    const before = await prisma.serialUnit.findFirstOrThrow({
      where: { serialNumber: "UT000111" },
    });

    const after = await prisma.$transaction((tx) =>
      correctSerial(tx, {
        serialUnitId: before.id, toSerial: "UT000lll",
        reason: "label re-read on the chassis", actor: "tech@local",
      })
    );

    // THE POINT: same unit, same cost layer, new label.
    expect(after.id).toBe(before.id);
    expect(after.lotId).toBe(before.lotId);
    expect(after.serialNumber).toBe("UT000111".replace("111", "LLL"));

    const audit = await prisma.serialCorrection.findMany({ where: { serialUnitId: before.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].fromSerial).toBe("UT000111");
    expect(audit[0].actor).toBe("tech@local");

    // Stock is untouched by a relabel.
    const bal = await prisma.inventoryBalance.findFirstOrThrow({
      where: { productId: unitreeId, warehouseId },
    });
    expect(bal.onHandQty).toBe(1);
  });

  it("refuses a correction that would collide with another unit", async () => {
    await prisma.$transaction(async (tx) => {
      await receiveSerials(tx, {
        productId: unitreeId, warehouseId, unitCostCents: 500_000,
        serials: [{ serialNumber: "UT222333" }, { serialNumber: "UT444555" }],
        sourceType: "TEST",
      });
      await applyBalanceDelta(tx, unitreeId, warehouseId, { onHandQty: 2 }, "seed");
    });
    const a = await prisma.serialUnit.findFirstOrThrow({ where: { serialNumber: "UT222333" } });

    await expect(
      prisma.$transaction((tx) =>
        correctSerial(tx, { serialUnitId: a.id, toSerial: "UT444555", actor: "t@local" })
      )
    ).rejects.toThrow(/already on file/i);
  });

  it("the review queue finds everything that was flagged", async () => {
    const flagged = await prisma.serialUnit.create({
      data: {
        productId: unitreeId, serialNumber: "UT-FLAGGED-1", warehouseId,
        status: "IN_STOCK", needsReview: true, reviewReason: "OCR confidence 0.40",
        serialSource: SERIAL_SOURCE.OCR, ocrConfidence: 0.4,
      },
    });
    const queue = await prisma.$transaction((tx) => reviewQueue(tx));
    expect(queue.map((u) => u.id)).toContain(flagged.id);

    // Clearing it is what a correction does, so the queue drains by being worked.
    await prisma.$transaction((tx) =>
      correctSerial(tx, { serialUnitId: flagged.id, toSerial: "UT888999", actor: "sweep@local" })
    );
    const after = await prisma.$transaction((tx) => reviewQueue(tx));
    expect(after.map((u) => u.id)).not.toContain(flagged.id);
  });
});
