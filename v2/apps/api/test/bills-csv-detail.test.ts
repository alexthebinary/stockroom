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
const { billDetailCsv } = await import(resolve(import.meta.dirname, "../../web/src/features/bills/BillDesk.tsx"));
const { toCsv } = await import(resolve(import.meta.dirname, "../../web/src/lib/csv.ts"));

const bill = (over: object) => ({
  id: 1, number: "BILL-1", kind: "INVENTORY", status: "POSTED", source: "MANUAL", vendorId: 1, vendor: { id: 1, name: "Acme" },
  poId: 7, po: { id: 7, number: "PO-7" }, vendorInvoiceNumber: "INV-9", billDate: "2026-01-02T00:00:00Z", termsDays: 30, dueDate: "2026-02-01T00:00:00Z",
  freightCents: 0, subtotalCents: 0, totalCents: 1500, paidCents: 0, creditedCents: 0, openCents: 1500, notes: null, attachment: null, targetPoIds: [], version: 0,
  createdAt: "2026-01-02T00:00:00Z", postedAt: null, postedBy: null,
  lines: [
    { id: 1, poLineId: 1, itemId: 5, description: null, qty: 2, unitCostCents: 500, discountCents: 0, amountCents: 1000, freightCents: 0, landedCents: 1000 },
    { id: 2, poLineId: null, itemId: null, description: "Handling, \"rush\"", qty: 1, unitCostCents: 500, discountCents: 0, amountCents: 500, freightCents: 0, landedCents: 500 },
  ],
  ...over,
});

describe("feedback #50: Export CSV Detail on Bills", () => {
  it("shows the button on the Bills page", async () => {
    const render = () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      client.setQueryData(["setup"], { required: false });
      client.setQueryData(["help-status"], { configured: true });
      client.setQueryData(["bills"], [bill({})]);
      client.setQueryData(["unknown"], []);
      client.setQueryData(["items"], []);
      try {
        return renderToStaticMarkup(createElement(MantineProvider, null,
          createElement(QueryClientProvider, { client },
            createElement(MemoryRouter, { initialEntries: ["/bills"] }, createElement(App)))));
      } finally {
        client.clear();
      }
    };
    await vi.waitFor(() => expect(render()).toContain("Export CSV Detail"));
  });

  it("writes one row per product and service line with the related documents", () => {
    const { header, rows } = billDetailCsv([bill({}) as never], [{ id: 5, sku: "SKU-5", name: "Widget" }]);
    expect(header).toEqual(expect.arrayContaining(["Bill", "Purchase order", "Related orders", "Vendor invoice", "Item SKU", "Item / service"]));
    expect(rows).toHaveLength(2);
    const csv = toCsv(header, rows);
    expect(csv).toContain("BILL-1,");
    expect(rows[0]).toEqual(expect.arrayContaining(["BILL-1", "PO-7", "INV-9", "SKU-5", "Widget", 2, "5.00", "10.00"]));
    expect(rows[1]).toEqual(expect.arrayContaining(['Handling, "rush"', "5.00"]));
    expect(csv).toContain('"Handling, ""rush"""');
  });

  it("lists the orders a freight-in bill was spread over", () => {
    const freight = bill({ id: 2, number: "BILL-2", kind: "FREIGHT_IN", po: null, poId: null, targetPoIds: [7, 9], lines: [] });
    const { rows } = billDetailCsv([bill({}) as never, freight as never]);
    expect(rows.every((r: unknown[]) => r[0] === "BILL-1")).toBe(true);
    const withLine = bill({ id: 2, number: "BILL-2", kind: "FREIGHT_IN", po: null, poId: null, targetPoIds: [7, 9], lines: [bill({}).lines[1]] });
    const out = billDetailCsv([bill({}) as never, withLine as never]).rows.find((r: unknown[]) => r[0] === "BILL-2")!;
    expect(out).toContain("PO-7; PO #9");
    expect(out).toContain("Freight in");
  });
});
