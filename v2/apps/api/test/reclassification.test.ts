import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

const { NewTransaction, TX_KINDS } = await import(resolve(import.meta.dirname, "../../web/src/features/settings/Items.tsx"));

describe("feedback #44: Inventory Reclassification", () => {
  it("moves quantity and cost from the old item to a new item with a new SKU and name", async () => {
    const { admin, ids } = await sampleCompany();
    const w = ids.warehouse;
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: w, qty: 10, unitCostCents: 1250 }] }));
    const result = ok(await admin.post("/api/reclassifications", { itemId: ids.widget, warehouseId: w, qty: 4, newSku: "RECLASS-1", newName: "Reclassified widget" })).body as { docNumber: string; toItemId: number; valueCents: number };
    expect(result.valueCents).toBe(5000);
    const d = testDb();
    const created = await d.item.findUniqueOrThrow({ where: { sku: "RECLASS-1" } });
    expect(created.name).toBe("Reclassified widget");
    expect(created.id).toBe(result.toItemId);
    const oldBal = await d.stockBalance.findFirstOrThrow({ where: { itemId: ids.widget, warehouseId: w } });
    const newBal = await d.stockBalance.findFirstOrThrow({ where: { itemId: created.id, warehouseId: w } });
    expect([oldBal.onHand, newBal.onHand]).toEqual([6, 4]);
    const oldPool = await d.costPool.findUniqueOrThrow({ where: { itemId: ids.widget } });
    const newPool = await d.costPool.findUniqueOrThrow({ where: { itemId: created.id } });
    expect([oldPool.qty, oldPool.valueCents]).toEqual([6, 7500]);
    expect([newPool.qty, newPool.valueCents]).toEqual([4, 5000]);
    const rows = ok(await admin.get("/api/other-transactions")).body as { number: string; type: string; qty: number; lines: number }[];
    expect(rows[0]).toMatchObject({ number: result.docNumber, type: "Inventory reclassification – in", qty: 0, lines: 2 });
    await expectBooksSound();
  });

  it("refuses a SKU that already exists and more units than are on hand, saving nothing", async () => {
    const { admin, ids } = await sampleCompany();
    const w = ids.warehouse;
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: w, qty: 2, unitCostCents: 100 }] }));
    ok(await admin.post("/api/reclassifications", { itemId: ids.widget, warehouseId: w, qty: 1, newSku: "SAMPLE-ROBOT", newName: "x" }), 409);
    const tooMany = await admin.post("/api/reclassifications", { itemId: ids.widget, warehouseId: w, qty: 5, newSku: "RECLASS-2", newName: "x" });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expect(await testDb().item.findUnique({ where: { sku: "RECLASS-2" } })).toBeNull();
    ok(await admin.post("/api/reclassifications", { itemId: ids.widget, warehouseId: w, qty: 1, newSku: " ", newName: "x" }), 400);
  });

  it("offers Inventory Reclassification as a New transaction option with SKU and name fields", () => {
    expect(Object.values(TX_KINDS).map((k) => (k as { label: string }).label)).toContain("Inventory Reclassification");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["items"], []);
    client.setQueryData(["warehouses"], []);
    client.setQueryData(["valuation"], { rows: [] });
    try {
      const html = renderToStaticMarkup(createElement(MantineProvider, null,
        createElement(QueryClientProvider, { client }, createElement(NewTransaction, { kind: "RECLASS", onPosted: async () => {} }))));
      for (const t of ["New SKU", "New item name", "Item", "Quantity"]) expect(html).toContain(t);
    } finally {
      client.clear();
    }
  });
});
