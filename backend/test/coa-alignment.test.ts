/**
 * The client's chart of accounts and journal entries, adopted 2026-09-24
 * ("Chart of Accounts & Transaction Journal Entries", three pages).
 *
 * Two things must hold: the chart an accountant opens reads like their sheet,
 * and moving a LIVE database onto it changes labels only — every historical
 * line stays on the same account and the books still balance.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { ACCOUNT, syncChartOfAccounts } from "../src/accounts";

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;
let sku = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "COA WH", code: "COAWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "COA Customer" } })).id;
});

async function balance(code: string) {
  const tb = await as(app, token).get("/api/trial-balance");
  return tb.body.accounts.find((a: { code: string }) => a.code === code)?.balanceCents ?? 0;
}

async function stocked(qty: number, cost: number, price: number) {
  sku += 1;
  const p = await prisma.product.create({
    data: { sku: `COA-${sku}`, name: `COA ${sku}`, brand: "XAG", defaultCostCents: cost, defaultPriceCents: price },
  });
  await as(app, token).post("/api/stock-adjustments").send({
    productId: p.id, warehouseId, adjustmentType: "INCREASE", quantity: qty, reason: "opening", unitCostCents: cost,
  });
  return p.id;
}

describe("client chart of accounts", () => {
  it("reads like the client's sheet", async () => {
    const rows = await prisma.account.findMany();
    const name = (code: string) => rows.find((a) => a.code === code)?.name;
    expect(name("1000")).toBe("Bank / Cash");
    expect(name("1100")).toBe("Accounts Receivable (AR)");
    expect(name("1210")).toBe("Inventory Clearing – Inbound");
    expect(name("1220")).toBe("Inventory Clearing – Outbound");
    expect(name("2000")).toBe("Accounts Payable (AP)");
    expect(name("3000")).toBe("Opening Balance Equity");
    expect(name("4100")).toBe("Inventory Adjustment Gain");
    expect(name("5000")).toBe("Cost of Goods Sold");
    expect(name("5100")).toBe("Inventory Adjustment Loss");
    expect(rows.find((a) => a.code === "1250")).toBeUndefined();
    expect(rows.find((a) => a.code === "4900")).toBeUndefined();
    const rules = await prisma.journalTemplate.findMany();
    const bill = rules.find((r) => r.transactionType === "PURCHASE_BILL");
    expect([bill?.debitAccountCode, bill?.creditAccountCode]).toEqual(["1210", "2000"]);
  });

  it("renumbers a live old-layout database in place, keeping every line on its account", async () => {
    const transit = await prisma.account.findUniqueOrThrow({ where: { code: ACCOUNT.INVENTORY_IN_TRANSIT } });
    const inbound = await prisma.account.findUniqueOrThrow({ where: { code: ACCOUNT.INVENTORY_CLEARING_INBOUND } });
    const gain = await prisma.account.findUniqueOrThrow({ where: { code: ACCOUNT.INVENTORY_ADJUSTMENT_GAIN } });
    // Put the database back into the pre-2026-09-24 layout.
    await prisma.account.update({ where: { id: inbound.id }, data: { code: "1250", name: "Prepaid Inventory" } });
    await prisma.account.update({ where: { id: transit.id }, data: { code: "1210", name: "Inventory In Transit" } });
    await prisma.account.update({ where: { id: gain.id }, data: { code: "4900", name: "Inventory Gain" } });
    const linesBefore = await prisma.journalLine.groupBy({ by: ["accountId"], _count: true });

    const changes = await syncChartOfAccounts();
    expect(changes).toEqual(expect.arrayContaining(["1210→1230", "1250→1210", "4900→4100"]));

    expect((await prisma.account.findUniqueOrThrow({ where: { id: inbound.id } })).code).toBe("1210");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: transit.id } })).code).toBe("1230");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: gain.id } })).code).toBe("4100");
    expect(await prisma.journalLine.groupBy({ by: ["accountId"], _count: true })).toEqual(linesBefore);
    expect((await syncChartOfAccounts()).length).toBe(0); // idempotent
    expect((await as(app, token).get("/api/trial-balance")).body.sound).toBe(true);
  });
});

describe("goods issue and cost on invoice (sheet 3.1 B, 3.3)", () => {
  it("shipping issues stock into outbound clearing and the invoice clears it into COGS", async () => {
    const api = as(app, token);
    const productId = await stocked(3, 1_000, 2_500);
    const cogsBefore = await balance(ACCOUNT.COGS);
    const o = await api.post("/api/sales-orders").send({ customerId, channel: "WHOLESALE", lines: [{ productId, warehouseId, quantity: 2 }] });
    await api.post(`/api/sales-orders/${o.body.id}/pack`);
    const shipped = await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);

    const types = (await prisma.journalEntry.findMany({
      where: { OR: [{ referenceType: "SHIPMENT", referenceId: shipped.body.shipment.id }, { referenceType: "SHIPMENT_COGS", referenceId: shipped.body.shipment.id }] },
    })).map((e) => e.transactionType).sort();
    expect(types).toEqual(["GOODS_ISSUE", "INVOICE_COGS"]);
    expect(await balance(ACCOUNT.INVENTORY_CLEARING_OUTBOUND)).toBe(0);
    expect(await balance(ACCOUNT.COGS)).toBe(cogsBefore + 2_000);
  });

  it("a shipment with no invoice leaves its cost waiting in outbound clearing", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 1_500, 3_000);
    const clearingBefore = await balance(ACCOUNT.INVENTORY_CLEARING_OUTBOUND);
    const o = await api.post("/api/sales-orders").send({ customerName: "Cash buyer", channel: "DIRECT", lines: [{ productId, warehouseId, quantity: 1 }] });
    await api.post(`/api/sales-orders/${o.body.id}/pack`);
    const shipped = await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
    expect(shipped.body.order.invoices).toHaveLength(0);
    expect(await balance(ACCOUNT.INVENTORY_CLEARING_OUTBOUND)).toBe(clearingBefore + 1_500);
  });

  it("voiding the invoice of a shipped order moves its cost back to clearing", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 800, 2_000);
    const o = await api.post("/api/sales-orders").send({ customerId, channel: "DIRECT", lines: [{ productId, warehouseId, quantity: 1 }] });
    await api.post(`/api/sales-orders/${o.body.id}/pack`);
    await api.post(`/api/sales-orders/${o.body.id}/ship`).send({});
    const clearingBefore = await balance(ACCOUNT.INVENTORY_CLEARING_OUTBOUND);
    const cogsBefore = await balance(ACCOUNT.COGS);
    const voided = await api.post(`/api/sales-orders/${o.body.id}/void-invoice`);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await balance(ACCOUNT.COGS)).toBe(cogsBefore - 800);
    expect(await balance(ACCOUNT.INVENTORY_CLEARING_OUTBOUND)).toBe(clearingBefore + 800);
    expect((await api.get("/api/trial-balance")).body.sound).toBe(true);
  });
});

describe("found by the 2026-09-24 reviews", () => {
  it("a product created in the app keeps its cost and price", async () => {
    const res = await as(app, token).post("/api/products").send({
      sku: "REV-COST-1", name: "Priced", defaultCostCents: 1234, defaultPriceCents: 5678,
    });
    expect(res.status).toBe(201);
    const row = await prisma.product.findUniqueOrThrow({ where: { sku: "REV-COST-1" } });
    expect([row.defaultCostCents, row.defaultPriceCents]).toEqual([1234, 5678]);
  });

  it("stock in transit between warehouses still reconciles with the ledger", async () => {
    const api = as(app, token);
    const other = (await prisma.warehouse.create({ data: { name: "COA WH2", code: "COAWH2" } })).id;
    const productId = await stocked(5, 1_000, 2_000);
    const t = await api.post("/api/stock-transfers").send({ productId, fromWarehouseId: warehouseId, toWarehouseId: other, quantity: 2 });
    expect((await api.post(`/api/stock-transfers/${t.body.id}/start`)).status).toBe(200);
    const v = await api.get("/api/reports/inventory-valuation");
    expect(v.body.inTransitCents).toBeGreaterThan(0);
    expect(v.body.varianceCents).toBe(0);
  });
});

describe("journal examples", () => {
  it("shows each rule's own count and latest real entry, never sample amounts", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 700, 1_500);
    const res = await api.get("/api/journal-examples");
    expect(res.status).toBe(200);
    const inc = res.body.data.find((r: { transactionType: string }) => r.transactionType === "ADJUSTMENT_INCREASE");
    expect(inc.debit.code).toBe("1200");
    expect(inc.postedCount).toBeGreaterThan(0);
    // The latest opening-stock adjustment is the one just made: 2 × 700.
    expect(inc.latest.lines.map((l: { code: string; debitCents: number; creditCents: number }) => [l.code, l.debitCents, l.creditCents]))
      .toEqual([["1200", 1_400, 0], ["4100", 0, 1_400]]);
    const unused = res.body.data.find((r: { transactionType: string }) => r.transactionType === "WARRANTY_REPLACEMENT");
    expect(unused.postedCount).toBe(0);
    expect(unused.latest).toBeNull();
    void productId;
  });
});
