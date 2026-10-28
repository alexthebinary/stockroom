import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type { Item } from "../../web/src/lib/types";

const { EditItem } = await import(resolve(import.meta.dirname, "../../web/src/features/settings/Items.tsx"));
const units = await import(resolve(import.meta.dirname, "../../web/src/lib/units.ts"));

const item: Item = {
  id: 1, sku: "09-017-00069", name: "Measured", trackingMode: "NONE", condition: "NEW",
  conditionOfId: null, defaultVendorId: null, lastCostCents: 0,
  weightKg: 2.5, lengthCm: 25.4, widthCm: 12.7, heightCm: 5.08,
};

const render = () => renderToStaticMarkup(createElement(MantineProvider, null,
  createElement(EditItem, { item, facets: undefined, onSaved: async () => {} })));

describe("item weight and dimensions in pounds and inches", () => {
  it("labels the edit form in lb and in, not kg and cm", () => {
    const html = render();
    expect(html).toContain("Weight (lb)");
    expect(html).toContain("Length × Width × Height (in)");
    expect(html).not.toMatch(/\(kg\)|\(cm\)/);
  });

  it("shows stored metric values as pounds and inches in the form", () => {
    const html = render();
    expect(html).toContain('value="5.512"'); // 2.5 kg
    expect(html).toContain('value="10"'); // 25.4 cm
    expect(html).toContain('value="5"'); // 12.7 cm
    expect(html).toContain('value="2"'); // 5.08 cm
  });

  it("converts entered pounds and inches to the stored units and back", () => {
    expect(units.lbToKg(10)).toBeCloseTo(4.5359237, 5);
    expect(units.inToCm(10)).toBeCloseTo(25.4, 10);
    expect(units.kgToLb(units.lbToKg(7.25))).toBe(7.25);
    expect(units.cmToIn(units.inToCm(12.5))).toBe(12.5);
  });

  it("lists measurements in lb and in", () => {
    expect(units.formatMeasurements(item)).toBe("5.512 lb · 10×5×2 in");
    expect(units.formatMeasurements({ lengthCm: 2.54 })).toBe("1×—×— in");
    expect(units.formatMeasurements({})).toBe("");
  });
});
