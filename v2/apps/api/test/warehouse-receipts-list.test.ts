import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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

function renderInventory(receipts: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["items", "", null, null], []);
  client.setQueryData(["item-facets"], { brands: [], categories: [] });
  client.setQueryData(["valuation"], { rows: [] });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["receipts"], receipts);
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/items?tab=receipts"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

const row = (id: number, po: string) => ({
  id, number: `WH-IN-${String(id).padStart(5, "0")}`, state: "PENDING_BILL", receivedAt: "2026-11-01T10:00:00Z",
  receivedBy: "Tester", po: { number: po }, lines: [{ qty: 2 }, { qty: 3 }],
});

describe("feedback #30: Warehouse receipts on Inventory", () => {
  it("shows a Warehouse receipts subsection under the Inventory heading", () => {
    const html = renderInventory([]);
    expect(html).toMatch(/<h1\b[^>]*>Stock<\/h1>/);
    expect(html).toContain("Warehouse receipts");
    expect(html.indexOf("Stock</h1>")).toBeLessThan(html.lastIndexOf("Warehouse receipts"));
  });

  it("lists every receipt with its sequential WH-IN number", () => {
    const html = renderInventory([row(3, "PO-00002"), row(2, "PO-00001"), row(1, "PO-00001")]);
    for (const n of ["WH-IN-00001", "WH-IN-00002", "WH-IN-00003"]) expect(html).toContain(n);
    expect(html).toMatch(/>5<[\s\S]*?units/);
  });
});
