import { describe, expect, it } from "vitest";
import { averageUnitCost, emptyPool, issue, receive, revalue } from "../src";

describe("average cost pool", () => {
  it("combines what is on hand with what arrives (GAAP guide §I.3)", () => {
    let pool = receive(emptyPool(), 2, 110000); // 2 widgets at $550 landed
    expect(averageUnitCost(pool)).toBe(55000);
    pool = receive(pool, 2, 130000); // 2 more at $650
    expect(pool).toEqual({ qty: 4, valueCents: 240000 });
    expect(averageUnitCost(pool)).toBe(60000);
  });

  it("issues at the average and the last unit drains exactly what is left", () => {
    let pool = receive(emptyPool(), 3, 100000); // $333.33…
    const first = issue(pool, 1);
    expect(first.costCents).toBe(33333);
    pool = first.pool;
    const second = issue(pool, 1);
    expect(second.costCents).toBe(33334);
    const last = issue(second.pool, 1);
    expect(last.costCents).toBe(33333);
    expect(last.pool).toEqual({ qty: 0, valueCents: 0 });
  });

  it("refuses to issue more than is costed", () => {
    expect(() => issue(receive(emptyPool(), 1, 100), 2)).toThrow(/only 1/);
  });

  it("revalues the units still on hand", () => {
    expect(revalue(receive(emptyPool(), 2, 100000), 10000)).toEqual({ qty: 2, valueCents: 110000 });
    expect(() => revalue(emptyPool(), 100)).toThrow(/no units/);
    expect(() => revalue(receive(emptyPool(), 1, 100), -200)).toThrow(/below zero/);
  });
});
