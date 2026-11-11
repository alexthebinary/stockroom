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

const row = (id: number, brand: string | null, category: string | null) => ({
  itemId: id, sku: `SKU${id}`, name: `Name${id}`, brand, category, onHand: 3, held: 0,
  valueCents: 300, averageCents: 100, glCents: 300, varianceCents: 0,
});

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["valuation"], {
    rows: [row(1, "XAG", "Drones"), row(2, null, "Parts"), row(3, null, null)],
    totalValueCents: 900, totalGlCents: 900,
  });
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/reports?cat=inventory&tab=stock"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #40: Brand · Category column on the Stock value report", () => {
  it("shows Brand · Category immediately before On hand, with each item's values", async () => {
    await vi.waitFor(() => expect(render()).toContain("SKU1"));
    const html = render();
    const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers).toContain("Brand · Category");
    expect(headers.indexOf("Brand · Category")).toBe(headers.indexOf("On hand") - 1);
    expect(html).toContain("XAG · Drones");
    expect(html).toContain(">Parts<");
  });
});
