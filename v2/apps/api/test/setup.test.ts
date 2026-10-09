import { beforeEach, describe, expect, it } from "vitest";
import { client, expectBooksSound, ok, resetDb, sampleCompany, testDb } from "./helpers";

describe("a fresh install", () => {
  beforeEach(resetDb);

  it("asks for setup and has nothing in it but the chart of accounts", async () => {
    const { body } = ok(await client().get("/api/setup"));
    expect(body.required).toBe(true);
    expect(body.counts).toEqual({ profiles: 0, warehouses: 0, vendors: 0, items: 0, stocked: 0 });
    const accounts = ok(await client().get("/api/accounts")).body;
    const codes = accounts.map((a: { code: string }) => a.code);
    expect(codes).toContain("1200");
    expect(codes).not.toContain("1201");
    expect(codes).not.toContain("1202");
  });

  it("loads the minimal sample: 1 warehouse, a supplier and a carrier, 3 items, no stock, no transactions", async () => {
    await sampleCompany();
    const d = testDb();
    expect(await d.warehouse.count()).toBe(1);
    expect(await d.vendor.findMany({ select: { kind: true }, orderBy: { kind: "asc" } })).toEqual([{ kind: "CARRIER" }, { kind: "SUPPLIER" }]);
    expect(await d.item.count()).toBe(3);
    expect(await d.stockBalance.count()).toBe(0);
    expect(await d.journalEntry.count()).toBe(0);
    expect(await d.purchaseOrder.count()).toBe(0);
    const openBox = await d.item.findUniqueOrThrow({ where: { sku: "SAMPLE-WIDGET-OB" }, include: { conditionOf: true } });
    expect(openBox.conditionOf?.sku).toBe("SAMPLE-WIDGET");
  });

  it("clears sample data while nothing real has happened, and refuses once something has", async () => {
    const { admin, ids } = await sampleCompany();
    expect(ok(await admin.get("/api/setup")).body.sample.canClear).toBe(true);
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: ids.warehouse, qty: 1, unitCostCents: 100 }] }));
    const refused = await admin.del("/api/setup/sample-data");
    expect(refused.status).toBe(409);
  });

  it("clears sample data back to an empty company", async () => {
    const { admin } = await sampleCompany();
    ok(await admin.del("/api/setup/sample-data"));
    const d = testDb();
    expect(await d.item.count()).toBe(0);
    expect(await d.vendor.count()).toBe(0);
    expect(await d.warehouse.count()).toBe(0);
  });

  it("won't finish setup without a name, a profile and a warehouse", async () => {
    const anon = client();
    const first = await anon.post("/api/setup/complete");
    expect(first.status).toBe(400);
    expect(first.body.error).toMatch(/company name.*profile.*warehouse/);
    const { admin } = await sampleCompany();
    ok(await admin.post("/api/setup/complete"));
    expect(ok(await admin.get("/api/setup")).body.required).toBe(false);
  });
});

describe("opening stock (GAAP guide §II.3 #1)", () => {
  it("posts Dr Inventory / Cr Opening Balance Equity, item by item, and the books stay sound", async () => {
    const { admin, ids } = await sampleCompany();
    const { body } = ok(
      await admin.post("/api/setup/opening-stock", {
        lines: [
          { itemId: ids.widget, warehouseId: ids.warehouse, qty: 6, unitCostCents: 50000 },
          { itemId: ids.openBox, warehouseId: ids.warehouse, qty: 1, unitCostCents: 0 },
        ],
      }),
    );
    expect(body.totalCents).toBe(300000);
    const accounts = ok(await admin.get("/api/accounts")).body as { code: string; balanceCents: number }[];
    expect(accounts.find((a) => a.code === "1200")!.balanceCents).toBe(300000);
    expect(accounts.find((a) => a.code === "3000")!.balanceCents).toBe(300000);
    const pool = await testDb().costPool.findUniqueOrThrow({ where: { itemId: ids.widget } });
    expect(pool).toMatchObject({ qty: 6, valueCents: 300000 });
    const report = await expectBooksSound();
    expect(report.figures.onHandGlCents).toBe(300000);
  });
});

describe("who's working", () => {
  it("stamps the profile on what they do and refuses changes from nobody once a team exists", async () => {
    const { ids, profiles } = await sampleCompany();
    const anonymous = await client().post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: ids.warehouse, qty: 1, unitCostCents: 1 }] });
    expect(anonymous.status).toBe(200); // setup routes stay open for the wizard
    const refused = await client().post("/api/warehouses", { code: "B", name: "Back room" });
    expect(refused.status).toBe(401);
    ok(await client(profiles.admin.id).post("/api/items/" + ids.widget + "/barcodes", { raw: "WIDGET-ALT" }));
    const audit = await testDb().auditEvent.findFirstOrThrow({ where: { action: "barcode.learned" } });
    expect(audit.actor).toBe("Ada Admin");
  });

  it("rejects a profile that does not exist", async () => {
    await sampleCompany();
    const response = await client(999).get("/api/items");
    expect(response.status).toBe(401);
  });
});
