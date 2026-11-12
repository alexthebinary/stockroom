import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { stockCsvRow } = await import(resolve(import.meta.dirname, "../../web/src/features/settings/Items.tsx"));

const base = { id: 1, sku: "A", name: "Thing", brand: "B", category: "C", priceCents: 1250 };

describe("Stock CSV export: Bundle column", () => {
  it("says Yes for a bundle and No for a plain item, after Name", () => {
    const bundle = stockCsvRow({ ...base, isBundle: true, available: 4 }, undefined);
    const plain = stockCsvRow({ ...base, isBundle: false }, { itemId: 1, onHand: 7, held: 0, valueCents: 0, averageCents: 0 });
    expect(Object.keys(plain).slice(0, 3)).toEqual(["SKU", "Name", "Bundle"]);
    expect(bundle.Bundle).toBe("Yes");
    expect(plain.Bundle).toBe("No");
    expect(bundle["On hand"]).toBe(4);
    expect(plain["On hand"]).toBe(7);
  });
});
