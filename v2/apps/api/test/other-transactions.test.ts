import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ok, sampleCompany } from "./helpers";

vi.mock("../../web/src/features/feedback/FeedbackLayer", () => ({ FeedbackLayer: () => null }));
vi.mock("../../web/src/lib/profile", () => ({
  useProfile: () => ({ profile: { id: 1, name: "Tester", job: "CLERK" }, choose: () => {} }),
  JOB_LABEL: { CLERK: "Warehouse" },
}));
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Drawer: ({ children }: { children: ReactNode }) => children,
}));

const { App } = await import(resolve(import.meta.dirname, "../../web/src/App.tsx"));

function renderInventory(rows: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["items", "", null, null], []);
  client.setQueryData(["item-facets"], { brands: [], categories: [] });
  client.setQueryData(["valuation"], { rows: [] });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["receipts"], []);
  client.setQueryData(["other-transactions"], rows);
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/items?tab=adjustments"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #31: Other Inventory Transactions", () => {
  it("API lists opening stock, gains and losses with distinct sequential numbers", async () => {
    const { admin, ids } = await sampleCompany();
    const w = ids.warehouse;
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: w, qty: 5, unitCostCents: 1000 }] }));
    ok(await admin.post("/api/adjustments", { itemId: ids.widget, warehouseId: w, qty: 2, unitCostCents: 1000, reason: "found a box" }));
    ok(await admin.post("/api/adjustments", { itemId: ids.widget, warehouseId: w, qty: -1, reason: "dropped one" }));
    const rows = ok(await admin.get("/api/other-transactions")).body as { number: string; type: string; qty: number }[];
    const mine = rows.slice(0, 3).reverse();
    expect(mine.map((r) => r.type)).toEqual(["Opening stock", "Inventory adjustment – gain", "Inventory adjustment – loss"]);
    expect(mine.map((r) => r.qty)).toEqual([5, 2, -1]);
    const nums = mine.map((r) => Number(r.number.replace("ADJ-", "")));
    expect(mine.every((r) => /^ADJ-\d{5}$/.test(r.number))).toBe(true);
    expect(nums[1]).toBe(nums[0]! + 1);
    expect(nums[2]).toBe(nums[1]! + 1);
  });

  it("shows the Stock Adjustments tab with each number", () => {
    const html = renderInventory([
      { number: "ADJ-00002", type: "Inventory adjustment – gain", date: "2026-11-02T10:00:00Z", qty: 2, lines: 1, actor: "Tester" },
      { number: "ADJ-00001", type: "Opening stock", date: "2026-11-01T10:00:00Z", qty: 5, lines: 1, actor: "Tester" },
    ]);
    expect(html).toContain("Stock Adjustments");
    expect(html.indexOf("Stock</h1>")).toBeLessThan(html.indexOf("ADJ-00001"));
    for (const t of ["ADJ-00001", "ADJ-00002", "Opening stock", "Inventory adjustment – gain"]) expect(html).toContain(t);
  });
});
