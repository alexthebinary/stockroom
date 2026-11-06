import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { stockValueCsv, movementCsv, journalCsv, trialBalanceCsv } = await import(resolve(import.meta.dirname, "../../web/src/features/reports/Reports.tsx"));
const { toCsv, downloadCsv } = await import(resolve(import.meta.dirname, "../../web/src/lib/csv.ts"));

const valuation = { rows: [{ itemId: 1, sku: "SKU-1", name: 'Widget, "large"', onHand: 3, held: 0, valueCents: 4550, averageCents: 1516.6, glCents: 4550, varianceCents: 0 }], totalValueCents: 4550, totalGlCents: 4550 };

function renderReports(url: string, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["setup"], { required: false });
  client.setQueryData(["help-status"], { configured: true });
  seed(client);
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: [url] }, createElement(App)))));
  } finally {
    client.clear();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("feedback #29: Export to CSV file on Reports", () => {
  it("shows the button above the stock value table", async () => {
    const render = () => renderReports("/reports?cat=inventory&tab=stock", (c) => c.setQueryData(["valuation"], valuation));
    // Reports is React.lazy in App: the first render only shows the fallback while the chunk loads.
    await vi.waitFor(() => expect(render()).toContain("Export to CSV file"));
    const html = render();
    const button = html.indexOf("Export to CSV file");
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(html.indexOf("<table"));
  });

  it("shows the button on the trial balance", async () => {
    const render = () => renderReports("/reports?cat=accounting&tab=tb", (c) => c.setQueryData(["tb"], { rows: [], totalDebitCents: 0, totalCreditCents: 0 }));
    await vi.waitFor(() => expect(render()).toContain("Export to CSV file"));
  });

  it("builds a CSV of the rows shown, escaping quotes and commas", () => {
    const { header, rows } = stockValueCsv(valuation.rows);
    expect(toCsv(header, rows)).toBe(
      'Item SKU,Item name,On hand,Average,Value,Ledger,Awaiting bill\r\nSKU-1,"Widget, ""large""",3,15.17,45.50,45.50,\r\n',
    );
  });

  it("neutralises spreadsheet formulas", () => {
    expect(toCsv(["a"], [["=1+1"]])).toBe("a\r\n'=1+1\r\n");
  });

  it("exports movement, journal and trial balance rows", () => {
    expect(movementCsv([{ id: 1, itemId: 1, transactionDate: "2026-01-02T00:00:00Z", type: "Warehouse receipt", sku: "S", name: "N", brand: null, category: null, inboundQty: 2, outboundQty: 0, endingBalance: 2 }]).rows).toEqual([["2026-01-02", "Warehouse receipt", "S", "N", "", "", 2, 0, 2]]);
    const entry = { number: "JE-1", date: "2026-01-03T00:00:00Z", actor: "Tester", event: "x", memo: null, reverses: null, lines: [{ id: 1, side: "DEBIT", amountCents: 500, account: { code: "1200", name: "Inventory" } }] };
    expect(journalCsv([entry as never]).rows[0]).toEqual(["JE-1", "2026-01-03", "Tester", "x", "", "1200 Inventory", "5.00", ""]);
    const tb = trialBalanceCsv([{ id: 1, code: "1200", name: "Inventory", isHeader: false, parentId: null, debitCents: 100, creditCents: 0 }], { debit: 100, credit: 100 });
    expect(tb.rows).toEqual([["1200 Inventory", "1.00", ""], ["Total (posting accounts)", "1.00", "1.00"]]);
  });

  it("downloadCsv saves a .csv file with the content", async () => {
    const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const blobs: Blob[] = [];
    vi.stubGlobal("document", { createElement: () => link, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => (blobs.push(b), "blob:x"), revokeObjectURL: vi.fn() });
    downloadCsv("stock-value.csv", "a,b\r\n");
    expect(link.download).toBe("stock-value.csv");
    expect(link.click).toHaveBeenCalledOnce();
    expect(await blobs[0]!.text()).toContain("a,b");
  });
});
