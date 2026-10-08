import { describe, expect, it } from "vitest";
import { clearedAt, landedCost, receiptValue, splitAdjustment } from "../src";

describe("landed cost (GAAP guide §I.4)", () => {
  it("2 widgets at $500 with $100 freight land at $550 each, $1,100 in total", () => {
    const [line] = landedCost([{ key: "w", qty: 2, unitCostCents: 50000 }], 10000, "VALUE");
    expect(line).toMatchObject({ goodsCents: 100000, freightCents: 10000, landedCents: 110000 });
    expect(line!.landedUnitCents).toBe(55000);
  });

  it("spreads freight by value across mixed lines and loses no cent", () => {
    const lines = landedCost(
      [
        { key: "a", qty: 3, unitCostCents: 1000 },
        { key: "b", qty: 1, unitCostCents: 7000 },
        { key: "c", qty: 10, unitCostCents: 333 },
      ],
      1001,
      "VALUE",
    );
    expect(lines.map((l) => l.freightCents)).toEqual([225, 526, 250]);
    expect(lines.reduce((s, l) => s + l.freightCents, 0)).toBe(1001);
  });

  it("spreads by quantity when asked, and nets a line discount first", () => {
    const lines = landedCost(
      [
        { key: "a", qty: 1, unitCostCents: 90000, discountCents: 20000 },
        { key: "b", qty: 3, unitCostCents: 100 },
      ],
      400,
      "QTY",
    );
    expect(lines[0]).toMatchObject({ goodsCents: 70000, freightCents: 100, landedCents: 70100 });
    expect(lines[1]).toMatchObject({ goodsCents: 300, freightCents: 300, landedCents: 600 });
  });

  it("falls back to quantity when every line is free", () => {
    const lines = landedCost([{ key: "a", qty: 1, unitCostCents: 0 }, { key: "b", qty: 1, unitCostCents: 0 }], 10, "VALUE");
    expect(lines.map((l) => l.freightCents)).toEqual([5, 5]);
  });

  it("refuses a discount larger than the line", () => {
    expect(() => landedCost([{ key: "a", qty: 1, unitCostCents: 100, discountCents: 101 }], 0, "VALUE")).toThrow(/discount/);
  });
});

describe("partial receipts clear a line's landed cost exactly", () => {
  it("telescopes so the final unit takes the remainder", () => {
    expect(clearedAt(100000, 3, 1)).toBe(33333);
    expect(clearedAt(100000, 3, 3)).toBe(100000);
    const slices = [1, 1, 1].reduce<{ before: number; values: number[] }>(
      (acc, n) => ({ before: acc.before + n, values: [...acc.values, receiptValue(100000, 3, acc.before, n)] }),
      { before: 0, values: [] },
    ).values;
    expect(slices).toEqual([33333, 33334, 33333]);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(100000);
  });
});

describe("an adjustment that arrives after the goods (freight-in bill, discount)", () => {
  it("goes to Inbound while nothing has arrived", () => {
    expect(splitAdjustment(10000, { lineQty: 2, receivedQty: 0, onHandQty: 0 })).toEqual({ inbound: 10000, onHand: 0, sold: 0 });
  });

  it("goes to the pool for units on hand and to COGS for units already sold", () => {
    expect(splitAdjustment(10000, { lineQty: 4, receivedQty: 4, onHandQty: 1 })).toEqual({ inbound: 0, onHand: 2500, sold: 7500 });
    expect(splitAdjustment(10001, { lineQty: 3, receivedQty: 2, onHandQty: 1 })).toEqual({ inbound: 3334, onHand: 3334, sold: 3333 });
  });

  it("handles a negative adjustment (a discount) the same way", () => {
    expect(splitAdjustment(-20000, { lineQty: 1, receivedQty: 1, onHandQty: 1 })).toEqual({ inbound: 0, onHand: -20000, sold: 0 });
  });

  it("refuses impossible quantities", () => {
    expect(() => splitAdjustment(1, { lineQty: 1, receivedQty: 2, onHandQty: 0 })).toThrow();
    expect(() => splitAdjustment(1, { lineQty: 2, receivedQty: 1, onHandQty: 2 })).toThrow();
  });
});
