import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, ok, resetDb, testDb } from "./helpers";

describe("global search", () => {
  let admin: ReturnType<typeof client>;
  let accountant: ReturnType<typeof client>;
  let clerk: ReturnType<typeof client>;
  const anonymous = client();
  let poId: number, billId: number, vendorId: number, itemId: number, journalId: number, creditId: number, paymentId: number;

  beforeAll(async () => {
    const db = await resetDb();
    const profiles = await Promise.all(["ADMIN", "ACCOUNTING", "CLERK"].map((job) => db.profile.create({ data: { name: job, job } })));
    admin = client(profiles[0]!.id);
    accountant = client(profiles[1]!.id);
    clerk = client(profiles[2]!.id);
    const warehouse = await db.warehouse.create({ data: { name: "Test warehouse", code: "TEST" } });
    const vendor = await db.vendor.create({ data: { name: "Needle Supply" } });
    vendorId = vendor.id;
    itemId = (await db.item.create({ data: { sku: "SKU-Needle", name: "Search widget", brand: "BrandOnly" } })).id;
    poId = (await db.purchaseOrder.create({ data: { number: "PO-Needle", vendorId, warehouseId: warehouse.id, createdBy: "test" } })).id;
    billId = (await db.vendorBill.create({ data: { number: "BILL-Needle", vendorId, poId, vendorInvoiceNumber: "InvoiceOnly", billDate: new Date(), dueDate: new Date() } })).id;
    journalId = (await db.journalEntry.create({ data: { number: "JE-000007", memo: "Needle MemoOnly", date: new Date(), event: "TEST", sourceType: "TEST", sourceId: 1, actor: "test" } })).id;
    creditId = (await db.vendorCredit.create({ data: { number: "VC-Needle", kind: "PRICE_ALLOWANCE", vendorId, billId, date: new Date(), totalCents: 100, actor: "test" } })).id;
    paymentId = (await db.payment.create({ data: { number: "PAY-Needle", direction: "OUT", vendorId, billId, amountCents: 100, paidAt: new Date(), actor: "test" } })).id;
  });

  afterAll(async () => {
    await Promise.all([admin, accountant, clerk, anonymous].filter(Boolean).map((c) => c.app.close()));
  });

  it.each(["", "?q=", "?q=a", "?q=%20a%20", "?q=%20%20"])("rejects missing or short trimmed query %s", async (query) => {
    expect((await admin.get(`/api/search${query}`)).status).toBe(400);
  });

  it("finds all seven groups case-insensitively with actionable destinations", async () => {
    const { body } = ok(await admin.get("/api/search?q=nEeDlE"));
    const expected = {
      purchaseOrders: { type: "purchaseOrder", id: poId, title: "PO-Needle", url: `/orders/${poId}` },
      bills: { type: "bill", id: billId, title: "BILL-Needle", url: `/bills/${billId}` },
      vendors: { type: "vendor", id: vendorId, title: "Needle Supply", url: "/settings" },
      items: { type: "item", id: itemId, title: "Search widget", url: "/items" },
      journalEntries: { type: "journalEntry", id: journalId, title: "JE-000007", url: "/reports?cat=accounting&tab=journal&journal_q=JE-000007" },
      credits: { type: "credit", id: creditId, title: "VC-Needle", url: `/bills/${billId}` },
      payments: { type: "payment", id: paymentId, title: "PAY-Needle", url: `/bills/${billId}` },
    };
    expect(Object.keys(body).sort()).toEqual(Object.keys(expected).sort());
    for (const [group, result] of Object.entries(expected)) {
      expect(body[group]).toHaveLength(1);
      expect(body[group][0]).toMatchObject({ ...result, subtitle: expect.any(String) });
    }
  });

  it.each([
    ["Supply", "purchaseOrders"], ["Supply", "bills"], ["InvoiceOnly", "bills"],
    ["widget", "items"], ["BrandOnly", "items"], ["JE-000007", "journalEntries"], ["MemoOnly", "journalEntries"],
  ])("matches %s in %s", async (query, group) => {
    const { body } = ok(await admin.get(`/api/search?q=${query}`));
    expect(body[group]).toHaveLength(1);
  });

  it("omits groups outside the clerk's navigation", async () => {
    const { body } = ok(await clerk.get("/api/search?q=needle"));
    expect(Object.keys(body).sort()).toEqual(["items", "purchaseOrders"]);
    expect(body.items).toHaveLength(1);
    expect(body.purchaseOrders).toHaveLength(1);
  });

  it("lets accounting search all its pages", async () => {
    const { body } = ok(await accountant.get("/api/search?q=needle"));
    expect(Object.keys(body).sort()).toEqual(["bills", "credits", "items", "journalEntries", "payments", "purchaseOrders", "vendors"]);
    expect(body.journalEntries).toHaveLength(1);
  });

  it("requires a chosen profile", async () => {
    expect((await anonymous.get("/api/search?q=needle")).status).toBe(401);
  });

  it("returns empty groups for no matches", async () => {
    const { body } = ok(await admin.get("/api/search?q=does-not-exist"));
    expect(Object.values(body).every((results) => Array.isArray(results) && results.length === 0)).toBe(true);
  });

  it("caps each group at eight results", async () => {
    const db = testDb();
    const profile = await db.profile.create({ data: { name: "Limit admin", job: "ADMIN" } });
    const c = client(profile.id);
    try {
      const warehouse = await db.warehouse.create({ data: { name: "Limit warehouse", code: "LIMIT" } });
      for (let i = 0; i < 10; i++) {
        const number = `Limit-${i}`;
        const vendor = await db.vendor.create({ data: { name: number } });
        await db.item.create({ data: { name: number, sku: number } });
        await db.purchaseOrder.create({ data: { number, vendorId: vendor.id, warehouseId: warehouse.id, createdBy: "test" } });
        const bill = await db.vendorBill.create({ data: { number, vendorId: vendor.id, billDate: new Date(), dueDate: new Date() } });
        await db.journalEntry.create({ data: { number, date: new Date(), event: "TEST", sourceType: "TEST", sourceId: i, actor: "test" } });
        await db.vendorCredit.create({ data: { number, kind: "PRICE_ALLOWANCE", vendorId: vendor.id, billId: bill.id, date: new Date(), totalCents: 100, actor: "test" } });
        await db.payment.create({ data: { number, direction: "OUT", vendorId: vendor.id, billId: bill.id, amountCents: 100, paidAt: new Date(), actor: "test" } });
      }
      const { body } = ok(await c.get("/api/search?q=limit"));
      expect(Object.values(body)).toHaveLength(7);
      for (const results of Object.values(body)) expect(results).toHaveLength(8);
    } finally {
      await c.app.close();
    }
  });
});
