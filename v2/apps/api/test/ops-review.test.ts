import { describe, expect, it } from "vitest";
import { checkBooks } from "../src/books";
import { inTx } from "../src/db";
import { postEntry } from "../src/ledger";
import { ok, sampleCompany, testDb } from "./helpers";

describe("ops review regressions", () => {
  it("#5 reserves inventory accounts for inventory roles", async () => {
    const c = await sampleCompany();
    const inventory = await testDb().account.findUniqueOrThrow({ where: { code: "1200" } });
    for (const role of ["bank", "payable", "cogs"]) {
      expect((await c.admin.put(`/api/posting-rules/${role}`, { accountId: inventory.id })).status).toBe(409);
    }
  });

  it("#5 catches legacy non-inventory postings to the actual inventory account", async () => {
    const c = await sampleCompany();
    const db = testDb();
    const inventory = await db.account.findUniqueOrThrow({ where: { code: "1200" } });
    await db.postingRule.update({ where: { role: "bank" }, data: { accountId: inventory.id } });
    await inTx(db, (tx) => postEntry(tx, {
      event: "BILL_PAYMENT", date: new Date(), sourceType: "TEST", sourceId: 1, actor: "test",
      lines: [{ role: "payable", amountCents: 100, vendorId: c.ids.supplier }, { role: "bank", amountCents: 100 }],
    }));
    // Clear AP's independent discrepancy so only the missed inventory issue remains.
    await db.vendorBill.create({ data: { number: "CREDIT-BALANCE", vendorId: c.ids.supplier, status: "POSTED", billDate: new Date(), dueDate: new Date(), totalCents: 0, creditedCents: 100 } });
    const report = await checkBooks(db);
    expect(report.sound).toBe(false);
    expect(report.problems.join("\n")).toMatch(/Inventory account 1200/);
  });
});

async function billed(c: Awaited<ReturnType<typeof sampleCompany>>, invoice = "INV-OPS", billDate = "2026-10-01") {
  const po = ok(await c.admin.post("/api/purchase-orders", { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: c.ids.widget, qtyOrdered: 1, unitCostCents: 10000 }] })).body;
  const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body;
  const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: invoice, billDate })).body;
  return ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version })).body;
}

it("#18 reconciles payable-role history after reassignment and partial payment", async () => {
  const c = await sampleCompany();
  const bill = await billed(c);
  const account = ok(await c.admin.post("/api/accounts", { code: "2010", name: "New payables", type: "LIABILITY", normalSide: "CREDIT" })).body;
  ok(await c.admin.put("/api/posting-rules/payable", { accountId: account.id }));
  ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 2500 }));
  const report = await checkBooks(testDb());
  expect(report.problems).toEqual([]);
  expect(report.figures.payableGlCents).toBe(7500);
  expect(report.figures.payableOpenCents).toBe(7500);
  // Role history still detects a real mismatch after reassignment.
  await testDb().vendorBill.update({ where: { id: bill.id }, data: { paidCents: 2501 } });
  expect((await checkBooks(testDb())).sound).toBe(false);
});
