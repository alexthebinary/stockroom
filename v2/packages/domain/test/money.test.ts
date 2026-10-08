import { describe, expect, it } from "vitest";
import { allocate, formatUsd, parseUsd } from "../src";

describe("allocate", () => {
  it("splits by weight and the parts always add back to the total", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(100, [1000, 500])).toEqual([67, 33]);
    for (const total of [1, 7, 99, 100_001]) {
      const parts = allocate(total, [3, 5, 11, 0, 2]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("gives a zero-weight part nothing", () => {
    expect(allocate(10, [0, 5, 5])).toEqual([0, 5, 5]);
  });

  it("allocates a negative total (a discount) with the same shape", () => {
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  it("refuses weights that cannot carry anything", () => {
    expect(() => allocate(10, [0, 0])).toThrow(/weights/);
    expect(() => allocate(10, [])).toThrow(/weights/);
    expect(() => allocate(10, [1, -1])).toThrow(/negative/);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
  });

  it("refuses fractions of a cent", () => {
    expect(() => allocate(10.5, [1])).toThrow(/whole cents/);
  });
});

describe("dollars and cents", () => {
  it("formats cents as US dollars", () => {
    expect(formatUsd(110000)).toBe("$1,100.00");
    expect(formatUsd(-4500)).toBe("-$45.00");
  });

  it("parses what a person types", () => {
    expect(parseUsd("1,100.00")).toBe(110000);
    expect(parseUsd("$550")).toBe(55000);
    expect(parseUsd("0.5")).toBe(50);
    expect(parseUsd("12.345")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
  });
});
