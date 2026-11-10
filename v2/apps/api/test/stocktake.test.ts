import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

const reason = "Stock count 2026-11-10";

describe("stocktake batch adjustment", () => {
  it("posts a loss, a gain and a loss as one ADJ document and keeps the books sound", async () => {
    const { admin, ids } = await sampleCompany();
    const db = testDb();
    const bolt = ok(await admin.post("/api/items", { sku: "BOLT", name: "Bolt" })).body as { id: number };
    const w = ids.warehouse;
    const opening = ok(await admin.post("/api/setup/opening-stock", { lines: [
      { itemId: ids.widget, warehouseId: w, qty: 10, unitCostCents: 1000 },
      { itemId: ids.openBox, warehouseId: w, qty: 4, unitCostCents: 2500 },
      { itemId: bolt.id, warehouseId: w, qty: 6, unitCostCents: 500 },
    ] })).body as { docNumber: string };

    const res = ok(await admin.post("/api/adjustments/batch", [
      { itemId: ids.widget, warehouseId: w, qty: -2, reason },
      { itemId: ids.openBox, warehouseId: w, qty: 3, reason },
      { itemId: bolt.id, warehouseId: w, qty: -1, reason },
    ])).body as { docNumber: string; lines: { itemId: number; qty: number; valueCents: number }[] };

    expect(res.docNumber).toMatch(/^ADJ-\d{5}$/);
    expect(res.docNumber).not.toBe(opening.docNumber);
    expect(res.lines).toEqual([
      { itemId: ids.widget, warehouseId: w, qty: -2, valueCents: 2000 },
      { itemId: ids.openBox, warehouseId: w, qty: 3, valueCents: 7500 },
      { itemId: bolt.id, warehouseId: w, qty: -1, valueCents: 500 },
    ]);

    const moves = await db.stockMovement.findMany({ where: { register: "ADJ", docNumber: res.docNumber, bucket: "ON_HAND" }, orderBy: { id: "asc" } });
    expect(moves.map((m) => [m.itemId, m.qtyDelta, m.valueCents])).toEqual([
      [ids.widget, -2, 2000],
      [ids.openBox, 3, 7500],
      [bolt.id, -1, 500],
    ]);
    const docs = await db.stockMovement.findMany({ where: { register: "ADJ", bucket: "ON_HAND" }, distinct: ["docNumber"], select: { docNumber: true } });
    expect(docs).toHaveLength(2);

    const entries = await db.journalEntry.findMany({ where: { memo: { contains: res.docNumber } }, include: { lines: true } });
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      const debit = entry.lines.filter((line) => line.side === "DEBIT").reduce((sum, line) => sum + line.amountCents, 0);
      const credit = entry.lines.filter((line) => line.side === "CREDIT").reduce((sum, line) => sum + line.amountCents, 0);
      expect(debit).toBe(credit);
      expect(debit).toBeGreaterThan(0);
    }
    const detail = ok(await admin.get(`/api/other-transactions/${res.docNumber}`)).body as { number: string; lines: unknown[] };
    expect(detail.number).toBe(res.docNumber);
    expect(detail.lines).toHaveLength(3);
    await expectBooksSound();

    const onHand = async (itemId: number) => (await db.stockBalance.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId, warehouseId: w } } })).onHand;
    expect(await onHand(ids.widget)).toBe(8);
    expect(await onHand(ids.openBox)).toBe(7);
    expect(await onHand(bolt.id)).toBe(5);
  });

  it("rolls back every line when one line cannot post", async () => {
    const { admin, ids } = await sampleCompany();
    const db = testDb();
    const bolt = ok(await admin.post("/api/items", { sku: "BOLT", name: "Bolt" })).body as { id: number };
    const w = ids.warehouse;
    ok(await admin.post("/api/setup/opening-stock", { lines: [
      { itemId: ids.widget, warehouseId: w, qty: 10, unitCostCents: 1000 },
      { itemId: ids.openBox, warehouseId: w, qty: 4, unitCostCents: 2500 },
      { itemId: bolt.id, warehouseId: w, qty: 6, unitCostCents: 500 },
    ] }));
    const movements = await db.stockMovement.count();
    const journals = await db.journalEntry.count();

    const failed = await admin.post("/api/adjustments/batch", [
      { itemId: ids.widget, warehouseId: w, qty: -1, reason },
      { itemId: ids.openBox, warehouseId: w, qty: 1, reason },
      { itemId: bolt.id, warehouseId: w, qty: -100, reason },
    ]);
    expect(failed.status).toBe(400);
    expect(await db.stockMovement.count()).toBe(movements);
    expect(await db.journalEntry.count()).toBe(journals);
    const onHand = async (itemId: number) => (await db.stockBalance.findUniqueOrThrow({ where: { itemId_warehouseId: { itemId, warehouseId: w } } })).onHand;
    expect(await onHand(ids.widget)).toBe(10);
    expect(await onHand(ids.openBox)).toBe(4);
    expect(await onHand(bolt.id)).toBe(6);
    await expectBooksSound();

    const again = ok(await admin.post("/api/adjustments", { itemId: ids.widget, warehouseId: w, qty: -1, reason: "after the failed stocktake" })).body as { docNumber: string };
    expect(again.docNumber).toBe("ADJ-00002");
  });

  it("rejects an empty batch and a zero difference", async () => {
    const { admin, ids } = await sampleCompany();
    const db = testDb();
    const w = ids.warehouse;
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: w, qty: 10, unitCostCents: 1000 }] }));
    const movements = await db.stockMovement.count();

    const empty = await admin.post("/api/adjustments/batch", []);
    expect(empty.status).toBe(400);
    expect(JSON.stringify(empty.body)).toContain("at least one difference");

    const zero = await admin.post("/api/adjustments/batch", [
      { itemId: ids.widget, warehouseId: w, qty: -1, reason },
      { itemId: ids.widget, warehouseId: w, qty: 0, reason },
    ]);
    expect(zero.status).toBe(400);
    expect(await db.stockMovement.count()).toBe(movements);
    await expectBooksSound();
  });
});
