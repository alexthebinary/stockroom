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

function renderStock(tab: string, shipments: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["items", "", null, null], []);
  client.setQueryData(["item-facets"], { brands: [], categories: [] });
  client.setQueryData(["valuation"], { rows: [] });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["receipts"], []);
  client.setQueryData(["other-transactions"], []);
  client.setQueryData(["sales-shipments"], shipments);
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: [`/items${tab}`] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #52: Sales shipments on the Stock page", () => {
  it("API lists every sales shipment (not receipts, adjustments or other WH-OUT) with order, customer and units", async () => {
    const { admin, ids } = await sampleCompany();
    const item = ok(await admin.post("/api/items", { sku: "SHIP-1", name: "Ship item", priceCents: 1200 })).body;
    ok(await admin.post("/api/adjustments", { itemId: item.id, warehouseId: ids.warehouse, qty: 10, unitCostCents: 500, reason: "test stock" }));
    const customer = ok(await admin.post("/api/customers", { name: "Northwind" })).body;
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`)).body;
    const list = ok(await admin.get("/api/sales-shipments")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: shipped.docNumber, units: 4, valueCents: 2000,
      order: { id: order.id, number: order.number }, customer: { name: "Northwind" },
    });
  });

  it("shows a Sales shipments tab directly after Warehouse receipts", () => {
    const html = renderStock("", []);
    const receipts = html.indexOf("Warehouse receipts");
    const shipments = html.indexOf("Sales shipments");
    const adjustments = html.indexOf("Stock adjustments");
    expect(receipts).toBeGreaterThan(-1);
    expect(shipments).toBeGreaterThan(receipts);
    expect(adjustments).toBeGreaterThan(shipments);
  });

  it("lists the shipments sent to customers", () => {
    const html = renderStock("?tab=shipments", [
      { number: "WH-OUT-00002", date: "2026-11-02T10:00:00Z", actor: "Tester", units: 3, valueCents: 1500, order: { id: 2, number: "SO-00002" }, customer: { id: 1, name: "Northwind" } },
      { number: "WH-OUT-00001", date: "2026-11-01T10:00:00Z", actor: "Tester", units: 4, valueCents: 2000, order: { id: 1, number: "SO-00001" }, customer: { id: 1, name: "Northwind" } },
    ]);
    for (const text of ["Sales shipments", "WH-OUT-00001", "WH-OUT-00002", "SO-00001", "Northwind"]) expect(html).toContain(text);
  });
});
