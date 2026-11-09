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

const row = (id: number, type: string, transaction: string, transactionUrl: string | null) => ({
  id, itemId: 1, transactionDate: "2026-04-01T10:00:00.000Z", type, transaction, transactionUrl,
  sku: "S", name: "N", brand: null, category: null, inboundQty: 1, outboundQty: 0, endingBalance: 1,
});

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["help-status"], { configured: true });
  client.setQueryData(["inventory-movement", "2026-04-01", "2026-04-30"], {
    rows: [row(1, "Warehouse receipt", "WH-IN-00008", "/orders/7"), row(2, "Purchase return", "VC-00001", "/bills/3"), row(3, "Inventory adjustment – gain", "ADJ-00001", null)],
  });
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/reports?cat=inventory&tab=movement&movement_from=2026-04-01&movement_to=2026-04-30"] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

describe("feedback #32: Transaction column on the inventory movement report", () => {
  it("shows Transaction right after Type, with links that open in a new tab", async () => {
    await vi.waitFor(() => expect(render()).toContain("WH-IN-00008"));
    const html = render();
    const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers.indexOf("Transaction")).toBe(headers.indexOf("Type") + 1);
    expect(html).toMatch(/<a href="\/orders\/7" target="_blank" rel="noopener noreferrer">WH-IN-00008<\/a>/);
    expect(html).toMatch(/<a href="\/bills\/3" target="_blank" rel="noopener noreferrer">VC-00001<\/a>/);
    expect(html).toContain("ADJ-00001");
    expect(html).not.toMatch(/<a [^>]*>ADJ-00001<\/a>/);
  });
});
