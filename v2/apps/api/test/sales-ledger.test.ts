import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

async function stocked(qty = 10, unitCostCents = 500) {
  const company = await sampleCompany();
  const { admin, ids } = company;
  const item = ok(await admin.post("/api/items", { sku: "LEDGER-1", name: "Ledger item", priceCents: 1200 })).body;
  ok(await admin.post("/api/adjustments", { itemId: item.id, warehouseId: ids.warehouse, qty, unitCostCents, reason: "test stock" }));
  const customer = ok(await admin.post("/api/customers", { name: "Northwind", termsDays: 15 })).body;
  return { ...company, item, customer };
}

type JournalLine = { role: string; side: string; amountCents: number; itemId: number | null; soLineId: number | null; customerId: number | null; account: { code: string } };

function sumRole(lines: { role: string; side: string; amountCents: number }[], role: string, side: string) {
  return lines.filter((l) => l.role === role && l.side === side).reduce((s, l) => s + l.amountCents, 0);
}

async function entry(event: string) {
  return testDb().journalEntry.findFirstOrThrow({
    where: { event },
    include: { lines: { include: { account: true } } },
    orderBy: { id: "desc" },
  });
}

describe("feedback #56 and #55: shipment and invoice postings", () => {
  it("ships into in-transit-out, then the invoice recognizes revenue, tax and COGS", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`)).body;
    expect(shipped.valueCents).toBe(2000);
    expect(shipped.docNumber).toBe("WH-OUT-00001");

    const shipEntry = await entry("SALES_SHIPPED");
    expect(shipEntry.memo).toBe(`${shipped.docNumber} · ${order.number}`);
    expect(shipEntry.sourceType).toBe("SALES_SHIP");
    expect(shipEntry.sourceId).toBe(order.id);
    const shipLines = shipEntry.lines as JournalLine[];
    expect(sumRole(shipLines, "inventoryOutbound", "DEBIT")).toBe(2000);
    expect(sumRole(shipLines, "inventoryOnHand", "CREDIT")).toBe(2000);
    expect(sumRole(shipLines, "cogs", "DEBIT")).toBe(0);
    expect(shipLines.every((l) => l.itemId === item.id && l.soLineId === order.lines[0].id)).toBe(true);
    let report = await expectBooksSound();
    expect(report.figures.outboundGlCents).toBe(2000);
    expect(report.figures.outboundOpenCents).toBe(2000);

    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    const invEntry = await entry("INVOICE_POSTED");
    expect(invEntry.memo).toBe(`${invoice.number} · ${order.number}`);
    expect(invEntry.sourceType).toBe("CUSTOMER_INVOICE");
    expect(invEntry.sourceId).toBe(invoice.id);
    expect(invoice.salesOrderId).toBe(order.id);
    const invLines = invEntry.lines as JournalLine[];
    expect(sumRole(invLines, "receivable", "DEBIT")).toBe(4800);
    expect(sumRole(invLines, "revenue", "CREDIT")).toBe(4800);
    expect(invLines.some((l) => l.role === "shippingRevenue" || l.role === "salesTaxPayable")).toBe(false);
    expect(sumRole(invLines, "cogs", "DEBIT")).toBe(2000);
    expect(sumRole(invLines, "inventoryOutbound", "CREDIT")).toBe(2000);
    expect(invLines.find((l) => l.role === "receivable")?.customerId).toBe(customer.id);
    expect(invLines.filter((l) => l.role === "cogs" || l.role === "inventoryOutbound").every((l) => l.itemId === item.id && l.soLineId === order.lines[0].id)).toBe(true);
    const line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: order.lines[0].id } });
    expect(line).toMatchObject({ qtyShipped: 4, qtyInvoiced: 4, qtyCosted: 4, shippedValueCents: 2000, cogsCents: 2000 });
    report = await expectBooksSound();
    expect(report.figures.outboundGlCents).toBe(0);
    expect(report.figures.outboundOpenCents).toBe(0);
  });

  it("invoices first, then the shipment expenses the units already billed", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    expect(invoice.totalCents).toBe(4800);
    const invLines = (await entry("INVOICE_POSTED")).lines as JournalLine[];
    expect(sumRole(invLines, "receivable", "DEBIT")).toBe(4800);
    expect(sumRole(invLines, "revenue", "CREDIT")).toBe(4800);
    expect(sumRole(invLines, "cogs", "DEBIT")).toBe(0);
    await expectBooksSound();

    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`)).body;
    expect(shipped.valueCents).toBe(2000);
    const shipLines = (await entry("SALES_SHIPPED")).lines as JournalLine[];
    expect(shipLines.find((l) => l.role === "inventoryOutbound" && l.side === "DEBIT")?.amountCents).toBe(2000);
    expect(sumRole(shipLines, "inventoryOnHand", "CREDIT")).toBe(2000);
    expect(sumRole(shipLines, "cogs", "DEBIT")).toBe(2000);
    expect(sumRole(shipLines, "inventoryOutbound", "CREDIT")).toBe(2000);
    const line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: order.lines[0].id } });
    expect(line).toMatchObject({ qtyShipped: 4, qtyInvoiced: 4, qtyCosted: 4, cogsCents: 2000 });
    const report = await expectBooksSound();
    expect(report.figures.outboundOpenCents).toBe(0);
  });

  it("costs only the overlap of a partial shipment and a partial invoice, and the last unit clears the remainder", async () => {
    const { admin, ids, item, customer } = await stocked(4, 500);
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1000 }],
    })).body;
    const lineId = order.lines[0].id;
    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`, { lines: [{ lineId, qty: 3 }] })).body;
    expect(shipped.valueCents).toBe(1500);
    let report = await expectBooksSound();
    expect(report.figures.outboundOpenCents).toBe(1500);

    const first = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`, { lines: [{ lineId, qty: 1 }] })).body;
    expect(first.subtotalCents).toBe(1000);
    expect(first.totalCents).toBe(1000);
    let inv = (await entry("INVOICE_POSTED")).lines as JournalLine[];
    expect(sumRole(inv, "cogs", "DEBIT")).toBe(500);
    expect(sumRole(inv, "revenue", "CREDIT")).toBe(1000);
    let line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line).toMatchObject({ qtyShipped: 3, qtyInvoiced: 1, qtyCosted: 1, cogsCents: 500 });
    report = await expectBooksSound();
    expect(report.figures.outboundOpenCents).toBe(1000);

    ok(await admin.post(`/api/sales-orders/${order.id}/invoice`, { lines: [{ lineId, qty: 2 }] }));
    inv = (await entry("INVOICE_POSTED")).lines as JournalLine[];
    expect(sumRole(inv, "cogs", "DEBIT")).toBe(1000);
    line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(line).toMatchObject({ qtyInvoiced: 3, qtyCosted: 3, cogsCents: 1500, shippedValueCents: 1500 });
    report = await expectBooksSound();
    expect(report.figures.outboundOpenCents).toBe(0);

    const odd = ok(await admin.post("/api/items", { sku: "ODD-1", name: "Odd cost", priceCents: 100 })).body;
    ok(await admin.post("/api/adjustments", { itemId: odd.id, warehouseId: ids.warehouse, qty: 2, unitCostCents: 10, reason: "two" }));
    ok(await admin.post("/api/adjustments", { itemId: odd.id, warehouseId: ids.warehouse, qty: 1, unitCostCents: 11, reason: "one" }));
    const oddOrder = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: odd.id, qtyOrdered: 3, unitPriceCents: 100 }],
    })).body;
    const oddLine = oddOrder.lines[0].id;
    const oddShip = ok(await admin.post(`/api/sales-orders/${oddOrder.id}/ship`)).body;
    expect(oddShip.valueCents).toBe(31);
    ok(await admin.post(`/api/sales-orders/${oddOrder.id}/invoice`, { lines: [{ lineId: oddLine, qty: 2 }] }));
    expect(sumRole((await entry("INVOICE_POSTED")).lines, "cogs", "DEBIT")).toBe(21);
    await expectBooksSound();
    ok(await admin.post(`/api/sales-orders/${oddOrder.id}/invoice`, { lines: [{ lineId: oddLine, qty: 1 }] }));
    expect(sumRole((await entry("INVOICE_POSTED")).lines, "cogs", "DEBIT")).toBe(10);
    const cleared = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: oddLine } });
    expect(cleared).toMatchObject({ qtyCosted: 3, shippedValueCents: 31, cogsCents: 31 });
    report = await expectBooksSound();
    expect(report.figures.outboundOpenCents).toBe(0);
  });

  it("splits shipping and tax onto their own credits and omits a zero line", async () => {
    const { admin, ids, item, customer } = await stocked(3, 100);
    const taxed = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse, shippingCents: 1500, taxRatePct: 8.25,
      lines: [{ itemId: item.id, qtyOrdered: 3, unitPriceCents: 1000 }],
    })).body;
    ok(await admin.post(`/api/sales-orders/${taxed.id}/ship`));
    const invoice = ok(await admin.post(`/api/sales-orders/${taxed.id}/invoice`)).body;
    expect(invoice).toMatchObject({ subtotalCents: 3000, shippingCents: 1500, taxCents: 371, totalCents: 4871 });
    const lines = (await entry("INVOICE_POSTED")).lines as JournalLine[];
    expect(sumRole(lines, "receivable", "DEBIT")).toBe(4871);
    expect(lines.find((l) => l.role === "revenue")).toMatchObject({ side: "CREDIT", amountCents: 3000, account: { code: "4000" } });
    expect(lines.find((l) => l.role === "shippingRevenue")).toMatchObject({ side: "CREDIT", amountCents: 1500, account: { code: "4100" } });
    expect(lines.find((l) => l.role === "salesTaxPayable")).toMatchObject({ side: "CREDIT", amountCents: 371, account: { code: "2100" } });
    expect(sumRole(lines, "cogs", "DEBIT")).toBe(300);
    await expectBooksSound();

    const plain = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse, shippingCents: 0, taxRatePct: 0,
      lines: [{ itemId: item.id, qtyOrdered: 1, unitPriceCents: 800 }],
    })).body;
    ok(await admin.post("/api/adjustments", { itemId: item.id, warehouseId: ids.warehouse, qty: 1, unitCostCents: 100, reason: "one more" }));
    ok(await admin.post(`/api/sales-orders/${plain.id}/ship`));
    const bare = ok(await admin.post(`/api/sales-orders/${plain.id}/invoice`)).body;
    expect(bare.totalCents).toBe(800);
    const bareLines = (await entry("INVOICE_POSTED")).lines as JournalLine[];
    expect(bareLines.some((l) => l.role === "shippingRevenue" || l.role === "salesTaxPayable")).toBe(false);
    expect(sumRole(bareLines, "revenue", "CREDIT")).toBe(800);
    expect(sumRole(bareLines, "receivable", "DEBIT")).toBe(800);
    await expectBooksSound();
  });

  it("voiding an invoice puts the cost back in in-transit-out", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 2, unitPriceCents: 1000 }],
    })).body;
    ok(await admin.post(`/api/sales-orders/${order.id}/ship`));
    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    expect((await expectBooksSound()).figures.outboundOpenCents).toBe(0);
    const voided = ok(await admin.post(`/api/customer-invoices/${invoice.id}/void`)).body;
    expect(voided.status).toBe("VOID");
    const line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: order.lines[0].id } });
    expect(line).toMatchObject({ qtyShipped: 2, qtyInvoiced: 0, qtyCosted: 0, shippedValueCents: 1000, cogsCents: 0 });
    const report = await expectBooksSound();
    expect(report.figures.outboundGlCents).toBe(1000);
    expect(report.figures.outboundOpenCents).toBe(1000);
    ok(await admin.post(`/api/sales-orders/${order.id}/invoice`));
    expect((await expectBooksSound()).figures.outboundOpenCents).toBe(0);
  });

  it("void after invoice-then-ship puts the shipment cost back in in-transit-out", async () => {
    const { admin, ids, item, customer } = await stocked();
    const order = ok(await admin.post("/api/sales-orders", {
      customerId: customer.id, warehouseId: ids.warehouse,
      lines: [{ itemId: item.id, qtyOrdered: 4, unitPriceCents: 1200 }],
    })).body;
    const invoice = ok(await admin.post(`/api/sales-orders/${order.id}/invoice`)).body;
    const shipped = ok(await admin.post(`/api/sales-orders/${order.id}/ship`)).body;
    expect(shipped.valueCents).toBe(2000);
    expect((await expectBooksSound()).figures.outboundOpenCents).toBe(0);

    ok(await admin.post(`/api/customer-invoices/${invoice.id}/void`));
    const line = await testDb().salesOrderLine.findUniqueOrThrow({ where: { id: order.lines[0].id } });
    expect(line).toMatchObject({ qtyShipped: 4, qtyInvoiced: 0, qtyCosted: 0, shippedValueCents: 2000, cogsCents: 0 });
    const correction = await testDb().journalEntry.findFirstOrThrow({
      where: { memo: `${invoice.number} void · ${order.number}` },
      include: { lines: true },
    });
    expect(correction.lines.filter((l) => l.role === "inventoryOutbound" && l.side === "DEBIT")).toEqual([
      expect.objectContaining({ amountCents: 2000, itemId: item.id, soLineId: order.lines[0].id }),
    ]);
    expect(sumRole(correction.lines, "cogs", "CREDIT")).toBe(2000);
    const report = await expectBooksSound();
    expect(report.figures.outboundGlCents).toBe(2000);
    expect(report.figures.outboundOpenCents).toBe(2000);

    ok(await admin.post(`/api/sales-orders/${order.id}/invoice`));
    expect((await expectBooksSound()).figures.outboundOpenCents).toBe(0);
  });

  it("seeds the new roles and keeps inventory shipped locked to 1200", async () => {
    const { admin } = await stocked();
    const rules = ok(await admin.get("/api/posting-rules")).body as { role: string; account: { code: string }; locked?: boolean }[];
    expect(rules.find((r) => r.role === "inventoryOutbound")?.account.code).toBe("1200");
    expect(rules.find((r) => r.role === "shippingRevenue")?.account.code).toBe("4100");
    expect(rules.find((r) => r.role === "salesTaxPayable")?.account.code).toBe("2100");
    const operating = ok(await admin.post("/api/accounts", { code: "1011", name: "Operating two", type: "ASSET", normalSide: "DEBIT" })).body;
    expect((await admin.put("/api/posting-rules/inventoryOutbound", { accountId: operating.id })).status).toBe(409);
    await expectBooksSound();
  });
});
