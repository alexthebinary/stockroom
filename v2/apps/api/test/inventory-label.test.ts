import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { goTo, readWiki } from "../src/ai/help";

vi.mock("../../web/src/features/feedback/FeedbackLayer", () => ({ FeedbackLayer: () => null }));
vi.mock("../../web/src/lib/profile", () => ({
  useProfile: () => ({ profile: { id: 1, name: "Tester", job: "CLERK" }, choose: () => {} }),
  JOB_LABEL: { CLERK: "Warehouse" },
}));
// Expose the drawer's content during SSR without needing a browser portal.
vi.mock("@mantine/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mantine/core")>(),
  Drawer: ({ children }: { children: ReactNode }) => children,
}));

const { App } = await import(resolve(import.meta.dirname, "../../web/src/App.tsx"));

function renderInventory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["items", "", null, null], []);
  client.setQueryData(["item-facets"], { brands: [], categories: [] });
  client.setQueryData(["valuation"], { rows: [] });
  client.setQueryData(["help-status"], { configured: true });
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/items"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #21: Inventory section", () => {
  it("sets the page title to Inventory", () => {
    expect(renderInventory()).toContain("<title>Inventory · ProfitIndex</title>");
  });

  it("renders the Inventory section heading at the existing /items route", () => {
    expect(renderInventory()).toMatch(/<h1\b[^>]*>Inventory<\/h1>/);
  });

  it("labels desktop and mobile navigation Inventory while retaining /items", () => {
    const html = renderInventory();
    const links = html.match(/<a\b[^>]*href="\/items"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toContain("Inventory");
      expect(link).not.toMatch(/>Items</);
      expect(link).toContain('aria-current="page"');
    }
  });

  it("uses Inventory in contextual help and help navigation without changing the path", () => {
    expect(renderInventory()).toContain("On Inventory");
    expect(goTo("items")).toEqual({ to: "/items", label: "Inventory" });
    expect(readWiki("items")).toMatch(/^# Inventory\n/);
    expect(readWiki("items")).not.toMatch(/\bItems\b/);
  });
});
