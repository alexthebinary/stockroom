import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb } from "./helpers";

const { EditItem, itemSaveBody, itemModalTitle } = await import(resolve(import.meta.dirname, "../../web/src/features/settings/Items.tsx"));

describe("feedback #45: editable SKU on the item card", () => {
  it("shows an editable SKU field, prefilled, instead of an Edit title with the SKU", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["vendors", "SUPPLIER"], []);
    try {
      const html = renderToStaticMarkup(createElement(MantineProvider, null,
        createElement(QueryClientProvider, { client },
          createElement(EditItem, { item: { id: 1, sku: "ABC-123", name: "Thing" }, facets: undefined, onSaved: async () => {} }))));
      expect(html).toContain("SKU");
      const input = html.match(/<input[^>]*value="ABC-123"[^>]*>/)?.[0] ?? "";
      expect(input).not.toBe("");
      expect(input).not.toContain("disabled");
      expect(input).not.toContain("readonly");
    } finally {
      client.clear();
    }
  });

  it("the editing modal no longer reads 'Edit <sku>'", () => {
    expect(itemModalTitle(true)).not.toMatch(/^Edit/);
    expect(itemModalTitle(true)).toBe("Item details");
    expect(itemModalTitle(false)).toBe("Add item");
  });

  it("the client save body carries the edited (trimmed) SKU, so a PUT from the card saves it", async () => {
    const form = {
      sku: "  NEW-SKU-45 ", name: "Widget", serialNumber: "", modelNumber: "", weightLb: "", lengthIn: "", widthIn: "",
      heightIn: "", brand: "", category: "", defaultVendorId: null, reorderPoint: "", reorderQty: "",
    };
    const body = itemSaveBody(form);
    expect(body.sku).toBe("NEW-SKU-45");
    const { admin, ids } = await sampleCompany();
    ok(await admin.put(`/api/items/${ids.widget}`, body));
    expect((await testDb().item.findUniqueOrThrow({ where: { id: ids.widget } })).sku).toBe("NEW-SKU-45");
  });

  it("saves a modified SKU and refuses one that another item uses", async () => {
    const { admin, ids } = await sampleCompany();
    ok(await admin.put(`/api/items/${ids.widget}`, { sku: "  NEW-SKU-45 " }));
    expect((await testDb().item.findUniqueOrThrow({ where: { id: ids.widget } })).sku).toBe("NEW-SKU-45");
    ok(await admin.post("/api/items", { sku: "OTHER-45", name: "Other" }));
    ok(await admin.put(`/api/items/${ids.widget}`, { sku: "OTHER-45" }), 409);
  });
});
