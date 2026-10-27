import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type { Item } from "../../web/src/lib/types";
import { ok, sampleCompany } from "./helpers";

// Vitest compiles the web TSX separately from the API's non-JSX TypeScript project.
const componentPath = resolve(import.meta.dirname, "../../web/src/features/settings/Items.tsx");
const { EditItem } = await import(componentPath);

describe("item serial and model numbers", () => {
  it("persists identifiers on create and edit, preserves omitted values, and allows clearing", async () => {
    const { admin, accountant } = await sampleCompany();
    const item = ok(await admin.post("/api/items", {
      sku: "IDENTIFIED", name: "Identified item", serialNumber: " SN-001 ", modelNumber: " MODEL-A ",
    })).body;
    expect(item).toMatchObject({ serialNumber: "SN-001", modelNumber: "MODEL-A" });
    expect(ok(await accountant.get(`/api/items/${item.id}`)).body).toMatchObject({ serialNumber: "SN-001", modelNumber: "MODEL-A" });
    expect(ok(await admin.put(`/api/items/${item.id}`, { serialNumber: "SN-002", modelNumber: "MODEL-B" })).body)
      .toMatchObject({ serialNumber: "SN-002", modelNumber: "MODEL-B" });
    ok(await admin.put(`/api/items/${item.id}`, { name: "Renamed" }));
    expect(ok(await accountant.get("/api/items?search=IDENTIFIED")).body)
      .toEqual([expect.objectContaining({ serialNumber: "SN-002", modelNumber: "MODEL-B" })]);
    expect(ok(await admin.put(`/api/items/${item.id}`, { serialNumber: " ", modelNumber: null })).body)
      .toMatchObject({ serialNumber: null, modelNumber: null });
    expect(ok(await accountant.get(`/api/items/${item.id}`)).body).toMatchObject({ serialNumber: null, modelNumber: null });
  });

  const item: Item = {
    id: 1, sku: "IDENTIFIED", name: "Identified item", trackingMode: "NONE", condition: "NEW",
    conditionOfId: null, defaultVendorId: null, lastCostCents: 0,
    serialNumber: "SN-001", modelNumber: "MODEL-A",
  };
  for (const [label, value] of [["Serial number", "SN-001"], ["Model number", "MODEL-A"]]) {
    it(`shows ${label} as an editable text input on the item edit card`, () => {
      const html = renderToStaticMarkup(createElement(MantineProvider, null,
        createElement(EditItem, { item, facets: undefined, onSaved: async () => {} })));
      const labelTag = html.match(new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}</label>`));
      expect(labelTag, `${label} label`).not.toBeNull();
      const input = html.match(new RegExp(`<input[^>]*id="${labelTag![1]}"[^>]*>`))?.[0];
      expect(input).toBeDefined();
      expect(input).toContain('type="text"');
      expect(input).toContain(`value="${value}"`);
      expect(input).not.toMatch(/\b(readonly|disabled)(?:=|\s|>)/i);
    });
  }
});
