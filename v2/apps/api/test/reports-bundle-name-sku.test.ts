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

const comp = { itemId: 9, sku: "COMP9", name: "Part Nine", qtyPerBundle: 2, onHand: 10, averageCents: 100 };
const bundle = (id: number) => ({
  itemId: id, sku: `BSKU${id}`, name: `Bundle Name ${id}`, onHand: 5, averageCents: 200, valueCents: 1000, components: [comp],
});

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["bundles-report"], { rows: [bundle(1), bundle(2)] });
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/reports?cat=inventory&tab=bundles"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #41: Bundle Name and Bundle SKU columns on the Bundles report", () => {
  it("renames Item to Bundle Name and adds Bundle SKU right after it", async () => {
    await vi.waitFor(() => expect(render()).toContain("BSKU1"));
    const html = render();
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers).not.toContain("Item");
    expect(headers).toContain("Bundle Name");
    expect(headers.indexOf("Bundle SKU")).toBe(headers.indexOf("Bundle Name") + 1);
    for (const id of [1, 2]) {
      expect(html).toMatch(new RegExp(`<td(?:\\s[^>]*)?>Bundle Name ${id}</td><td(?:\\s[^>]*)?>BSKU${id}</td>`));
    }
  });
});
