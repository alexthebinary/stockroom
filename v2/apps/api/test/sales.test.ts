import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

async function stocked() {
  const company = await sampleCompany();
  const { admin, ids } = company;
  const item = ok(await admin.post("/api/items", { sku: "SALE-1", name: "Sale item", priceCents: 1200 })).body;
  ok(await admin.post("/api/adjustments", { itemId: item.id, warehouseId: ids.warehouse, qty: 10, unitCostCents: 500, reason: "test stock" }));
  const customer = ok(await admin.post("/api/customers", { name: "Northwind", termsDays: 15 })).body;
  return { ...company, item, customer };
}

function sum(lines: { account: { code: string }; side: string; amountCents: number }[], code: string, side: string) {
  return lines.filter((l) => l.account.code === code && l.side === side).reduce((s, l) => s + l.amountCents, 0);
}

describe("sales", () => {
  it("numbers sales orders SO-00001, SO-00002", async () => {
    const { admin, ids, item, customer } = await stocked();
    const first = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const second = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 1, unitPriceCents: 1200 }],
    })).body;
    expect(first.number).toBe("SO-00001");
    expect(second.number).toBe("SO-00002");
    expect(first.lifecycle).toBe("OPEN");
    expect(first.shippingStatus).toBe("NOT_SHIPPED");
    expect(first.invoicingStatus).toBe("NOT_INVOICED");
  });

  it("ships at average cost, invoices AR and revenue, and a payment clears AR", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`)).body;
    expect(shipped.valueCents).toBe(4 * 500);
    const db = testDb();
    expect((await db.stockBalance.findFirstOrThrow({ where: { itemId: item.id, warehouseId: ids.warehouse } })).onHand).toBe(6);

    const shipEntry = await db.journalEntry.findFirstOrThrow({ where: { event: "SALES_SHIPPED" }, include: { lines: { include: { account: true } } } });
    expect(sum(shipEntry.lines, "5000", "DEBIT")).toBe(2000);
    expect(sum(shipEntry.lines, "1200", "CREDIT")).toBe(2000);

    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    expect(invoice.number).toBe("INV-00001");
    expect(invoice.status).toBe("POSTED");
    expect(invoice.totalCents).toBe(4800);
    const invEntry = await db.journalEntry.findFirstOrThrow({ where: { event: "INVOICE_POSTED" }, include: { lines: { include: { account: true } } } });
    expect(sum(invEntry.lines, "1100", "DEBIT")).toBe(4800);
    expect(sum(invEntry.lines, "4000", "CREDIT")).toBe(4800);
    expect(invEntry.lines.find((l) => l.role === "receivable")?.customerId).toBe(customer.id);

    const payment = ok(await admin.post(`/api/customer-invoices/${invoice.id}/payments`, { amountCents: 4800 })).body;
    expect(payment.number).toBe("CP-00001");
    const payEntry = await db.journalEntry.findFirstOrThrow({ where: { event: "CUSTOMER_PAYMENT" }, include: { lines: { include: { account: true } } } });
    expect(sum(payEntry.lines, "1000", "DEBIT")).toBe(4800);
    expect(sum(payEntry.lines, "1100", "CREDIT")).toBe(4800);
    const ar = await db.journalLine.findMany({ where: { role: "receivable", customerId: customer.id } });
    const net = ar.reduce((s, l) => s + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0);
    expect(net).toBe(0);
    expect((await db.customerInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).paidCents).toBe(4800);
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe("PAID");
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).shippingStatus).toBe("SHIPPED");

    const lines = await db.journalLine.findMany();
    const debits = lines.filter((l) => l.side === "DEBIT").reduce((s, l) => s + l.amountCents, 0);
    const credits = lines.filter((l) => l.side === "CREDIT").reduce((s, l) => s + l.amountCents, 0);
    expect(debits).toBe(credits);
    await expectBooksSound();
    expect(ok(await admin.get("/api/reports/ar-aging")).body.customers).toEqual([]);
  });

  it("refuses to ship more than is on hand and posts nothing", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 11, unitPriceCents: 100 }],
    })).body;
    const before = await testDb().journalEntry.count();
    const res = await admin.post(`/api/sales-orders/${order.id}/ship`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Sale item");
    expect(await testDb().journalEntry.count()).toBe(before);
    expect((await testDb().stockBalance.findFirstOrThrow({ where: { itemId: item.id } })).onHand).toBe(10);
    await expectBooksSound();
  });

  it("voids an unpaid invoice by reversing it, and will not void a paid one", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 2, unitPriceCents: 1000 }],
    })).body;
    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    ok(await admin.post(`/api/customer-invoices/${invoice.id}/payments`, { amountCents: 500 }));
    expect((await admin.post(`/api/customer-invoices/${invoice.id}/void`)).status).toBe(409);
    const fresh = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 1, unitPriceCents: 800 }],
    })).body;
    const other = ok(await admin.post(`/api/sales-orders/${fresh.id}/invoice`)).body;
    const voided = ok(await admin.post(`/api/customer-invoices/${other.id}/void`)).body;
    expect(voided.status).toBe("VOID");
    const reversal = await testDb().journalEntry.findFirst({ where: { sourceType: "CUSTOMER_INVOICE", sourceId: other.id, reversesId: { not: null } } });
    expect(reversal).toBeTruthy();
    expect((await testDb().salesOrder.findUniqueOrThrow({ where: { id: fresh.id } })).invoicingStatus).toBe("NOT_INVOICED");
    await expectBooksSound();
  });
});
