/**
 * The settlement filter must partition the WHOLE list, not the current page.
 *
 * It was implemented as a post-filter over one page of 25: the database paged
 * first, then paid/unpaid was applied in memory and `total` was reported as
 * the length of what survived. So a page whose 25 rows were all unpaid
 * returned `data: []`, `total: 0`, `totalPages: 1` for ?settlement=PAID — the
 * UI shows "no invoices match" and hides pagination, and every paid invoice
 * further down the list is unreachable.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { createLot } from "../src/costing";

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;
let paidInvoiceIds: number[] = [];

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Page WH", code: "PAGEWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "Page Customer" } })).id;
  const api = as(app, token);

  // 30 invoices: the first 28 raised (unpaid), the last 2 settled. With a page
  // size of 25 and newest-first ordering, the two paid ones fall on page 2.
  for (let i = 0; i < 30; i += 1) {
    const p = await prisma.product.create({
      data: { sku: `PAGE-${i}`, name: `Page ${i}`, brand: "XAG", defaultPriceCents: 1_000 },
    });
    await prisma.inventoryBalance.create({
      data: { productId: p.id, warehouseId, onHandQty: 5 },
    });
    await prisma.$transaction((tx) =>
      createLot(tx, { productId: p.id, warehouseId, quantity: 5, unitCostCents: 500, sourceType: "TEST" })
    );
    const created = await api.post("/api/sales-orders").send({
      customerId, lines: [{ productId: p.id, warehouseId, quantity: 1, unitPriceCents: 1_000 }],
    });
    const id = created.body.id;
    await api.post(`/api/sales-orders/${id}/pack`);
    await api.post(`/api/sales-orders/${id}/invoice`);
    if (i < 2) {
      await api.post(`/api/sales-orders/${id}/pay`);
      const d = await api.get(`/api/sales-orders/${id}`);
      paidInvoiceIds.push(d.body.invoices[0].id);
    }
  }
});

describe("settlement filter and pagination", () => {
  it("finds paid invoices that do not fall on the first page", async () => {
    const api = as(app, token);
    const res = await api.get("/api/sales-orders/invoices?settlement=PAID&page=1&pageSize=25");
    expect(res.status).toBe(200);
    // The two settled invoices are the OLDEST of 30, so ordering by issueDate
    // desc puts them well past the first page of an unfiltered list.
    for (const id of paidInvoiceIds) {
      expect(res.body.data.some((i: any) => i.id === id)).toBe(true);
    }
  });

  it("reports a total that counts the whole filtered set, not one page", async () => {
    const api = as(app, token);
    const unpaid = await api.get("/api/sales-orders/invoices?settlement=UNPAID&pageSize=10");
    expect(unpaid.body.data.length).toBeLessThanOrEqual(10);
    // 28 unpaid exist; a page-local count would report 10.
    expect(unpaid.body.total).toBeGreaterThanOrEqual(28);
    expect(unpaid.body.totalPages).toBeGreaterThanOrEqual(3);
  });

  it("pages through the filtered set without repeating or losing rows", async () => {
    const api = as(app, token);
    const seen = new Set<number>();
    let pages = 0;
    for (let page = 1; page <= 10; page += 1) {
      const res = await api.get(`/api/sales-orders/invoices?settlement=UNPAID&page=${page}&pageSize=10`);
      if (res.body.data.length === 0) break;
      pages += 1;
      for (const row of res.body.data) {
        expect(seen.has(row.id)).toBe(false); // no row appears twice
        seen.add(row.id);
        expect(row.outstandingCents).toBeGreaterThan(0);
      }
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen.size).toBeGreaterThanOrEqual(28);
  });

  it("applies the same fix to vendor bills", async () => {
    const api = as(app, token);
    const res = await api.get("/api/purchase-orders/bills?settlement=UNPAID&pageSize=5");
    expect(res.status).toBe(200);
    expect(res.body.data.every((b: any) => b.outstandingCents > 0)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.data.length);
  });
});
