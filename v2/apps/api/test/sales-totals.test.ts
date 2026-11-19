import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

const { InvoiceDetail, SalesOrderDetail } = await import(resolve(import.meta.dirname, "../../web/src/features/sales/Sales.tsx"));

async function setup() {
  const company = await sampleCompany();
  const item = ok(await company.admin.post("/api/items", { sku: "TOT-1", name: "Totals item", priceCents: 1000 })).body;
  const customer = ok(await company.admin.post("/api/customers", { name: "Contoso" })).body;
  return { ...company, item, customer };
}

function renderAt(path: string, route: string, key: unknown[], data: unknown, element: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(key, data);
  client.setQueryData(["items"], []);
  try {
    return renderToStaticMarkup(createElement(MantineProvider, null,
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: [path] },
          createElement(Routes, null, createElement(Route, { path: route, element: element as never }))))));
  } finally {
    client.clear();
  }
}

const labelOrder = (html: string) => ["Subtotal", "Shipping &amp; Handling", "Sales Tax (", "Total"].map((l) => html.lastIndexOf(l));

describe("feedback #54: subtotal, shipping & handling, sales tax, total", () => {
  it("computes the order's subtotal, tax on (subtotal + shipping), and total", async () => {
    const { admin, ids, item, customer } = await setup();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse, shippingCents: 1500, taxRatePct: 8.25,
      lines: [{ itemId: item.id, qtyOrdered: 3, unitPriceCents: 1000 }],
    })).body;
    const got = ok(await admin.get(`/api/sales-orders/${order.id}`)).body;
    expect(got.subtotalCents).toBe(3000);
    expect(got.shippingCents).toBe(1500);
    expect(got.taxRatePct).toBe(8.25);
    expect(got.taxCents).toBe(371); // (3000 + 1500) * 8.25% = 371.25
    expect(got.totalCents).toBe(3000 + 1500 + 371);
    ok(await admin.put(`/api/sales-orders/${order.id}`, { version: got.version, shippingCents: 0, taxRatePct: 10 }));
    const after = ok(await admin.get(`/api/sales-orders/${order.id}`)).body;
    expect(after.shippingCents).toBe(0);
    expect(after.totalCents).toBe(3300);
  });

  it("copies shipping and tax onto the invoice and posts the total to AR", async () => {
    const { admin, ids, item, customer } = await setup();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse, shippingCents: 1500, taxRatePct: 8.25,
      lines: [{ itemId: item.id, qtyOrdered: 3, unitPriceCents: 1000 }],
    })).body;
    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    const got = ok(await admin.get(`/api/customer-invoices/${invoice.id}`)).body;
    expect(got).toMatchObject({ subtotalCents: 3000, shippingCents: 1500, taxRatePct: 8.25, taxCents: 371, totalCents: 4871, openCents: 4871 });
    const ar = await testDb().journalLine.findMany({ where: { role: "receivable", customerId: customer.id } });
    expect(ar.reduce((s, l) => s + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0)).toBe(4871);
    await expectBooksSound();
  });

  it("charges shipping once across partial invoices", async () => {
    const { admin, ids, item, customer } = await setup();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse, shippingCents: 500, taxRatePct: 0,
      lines: [{ itemId: item.id, qtyOrdered: 1, unitPriceCents: 1000 }],
    })).body;
    const first = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    expect(first.totalCents).toBe(1500);
    const fresh = ok(await admin.get(`/api/sales-orders/${order.id}`)).body;
    ok(await admin.put(`/api/sales-orders/${order.id}`, { version: fresh.version, lines: [{ id: fresh.lines[0].id, itemId: item.id, qtyOrdered: 2, unitPriceCents: 1000 }] }));
    const second = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    expect(second.shippingCents).toBe(0);
    expect(second.totalCents).toBe(1000);
  });

  it("renders the four fields in order, Total last, on the invoice page", () => {
    const html = renderAt("/sales/invoices/2", "/sales/invoices/:id", ["customer-invoice", "2"], {
      id: 2, number: "INV-00002", status: "POSTED", totalCents: 4871, paidCents: 0, openCents: 4871, dueDate: "2026-12-01T00:00:00Z", invoiceDate: "2026-11-01T00:00:00Z",
      termsDays: 30, subtotalCents: 3000, shippingCents: 1500, taxRatePct: 8.25, taxCents: 371, lines: [], payments: [], customer: null, salesOrder: null,
    }, createElement(InvoiceDetail));
    const [sub = -1, ship = -1, tax = -1, total = -1] = labelOrder(html);
    expect(sub).toBeGreaterThan(-1);
    expect(sub).toBeLessThan(ship);
    expect(ship).toBeLessThan(tax);
    expect(tax).toBeLessThan(total);
    expect(html).toContain("Sales Tax (8.25%)");
    expect(html).toContain("$48.71");
    expect(html).toContain("$15.00");
    expect(html).toContain("$3.71");
  });

  it("renders the same fields on the sales order page", () => {
    const html = renderAt("/sales/orders/1", "/sales/orders/:id", ["sales-order", "1"], {
      id: 1, number: "SO-00001", customerId: 1, customer: null, warehouseId: 1, warehouse: null, lifecycle: "OPEN", invoicingStatus: "NOT_INVOICED",
      paymentStatus: "UNPAID", shippingStatus: "NOT_SHIPPED", notes: null, version: 0, createdAt: "2026-11-01T00:00:00Z", createdBy: "t", lines: [],
      subtotalCents: 3000, shippingCents: 1500, taxRatePct: 8.25, taxCents: 371, totalCents: 4871, invoices: [],
    }, createElement(SalesOrderDetail));
    const [sub = -1, ship = -1, tax = -1, total = -1] = labelOrder(html);
    expect(sub).toBeGreaterThan(-1);
    expect(sub).toBeLessThan(ship);
    expect(ship).toBeLessThan(tax);
    expect(tax).toBeLessThan(total);
    expect(html).toContain("$48.71");
  });
});
