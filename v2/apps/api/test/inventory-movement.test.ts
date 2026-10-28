import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb } from "./helpers";

describe("inventory movement report", () => {
  it("carries opening stock into per-item balances, excludes held stock, and includes the entire end date", async () => {
    const { admin, accountant, ids } = await sampleCompany();
    ok(await admin.put(`/api/items/${ids.widget}`, { brand: "Acme", category: "Parts" }));
    const db = testDb();
    const otherWarehouse = await db.warehouse.create({ data: { code: "SECOND", name: "Second warehouse" } });
    const movement = async (itemId: number, qtyDelta: number, date: string, bucket = "ON_HAND", warehouseId = ids.warehouse) => db.stockMovement.create({
      data: { itemId, warehouseId, qtyDelta, createdAt: new Date(date), bucket, register: qtyDelta > 0 ? "WH_IN" : "WH_OUT", docNumber: "TEST", counterType: "ADJUSTMENT", counterId: 1, actor: "Test" },
    });
    await movement(ids.widget, 10, "2026-01-31T23:59:59.999Z");
    await movement(ids.widget, -2, "2026-01-30T12:00:00Z");
    await movement(ids.widget, 100, "2026-01-31T12:00:00Z", "HELD");
    // Insert out of chronological order; equal timestamps must follow movement ID.
    const outbound = await movement(ids.widget, -3, "2026-02-02T12:00:00Z");
    const inbound = await movement(ids.widget, 4, "2026-02-01T00:00:00Z", "ON_HAND", otherWarehouse.id);
    const robot = await movement(ids.robot, 2, "2026-02-02T12:00:00Z");
    const tied = await movement(ids.widget, 2, "2026-02-02T12:00:00Z");
    const last = await movement(ids.widget, 1, "2026-02-28T23:59:59.999Z");
    await movement(ids.widget, -100, "2026-02-02T12:00:00Z", "HELD");
    await movement(ids.widget, 50, "2026-03-01T00:00:00Z");

    const report = ok(await accountant.get("/api/reports/inventory-movement?from=2026-02-01&to=2026-02-28")).body;
    expect(report.rows).toEqual([
      { id: inbound.id, itemId: ids.widget, transactionDate: inbound.createdAt.toISOString(), sku: "SAMPLE-WIDGET", name: "Sample Widget", brand: "Acme", category: "Parts", inboundQty: 4, outboundQty: 0, endingBalance: 12 },
      { id: outbound.id, itemId: ids.widget, transactionDate: outbound.createdAt.toISOString(), sku: "SAMPLE-WIDGET", name: "Sample Widget", brand: "Acme", category: "Parts", inboundQty: 0, outboundQty: 3, endingBalance: 9 },
      { id: robot.id, itemId: ids.robot, transactionDate: robot.createdAt.toISOString(), sku: "SAMPLE-ROBOT", name: "Sample Robot (serial-tracked)", brand: null, category: null, inboundQty: 2, outboundQty: 0, endingBalance: 2 },
      { id: tied.id, itemId: ids.widget, transactionDate: tied.createdAt.toISOString(), sku: "SAMPLE-WIDGET", name: "Sample Widget", brand: "Acme", category: "Parts", inboundQty: 2, outboundQty: 0, endingBalance: 11 },
      { id: last.id, itemId: ids.widget, transactionDate: last.createdAt.toISOString(), sku: "SAMPLE-WIDGET", name: "Sample Widget", brand: "Acme", category: "Parts", inboundQty: 1, outboundQty: 0, endingBalance: 12 },
    ]);
    expect(ok(await accountant.get("/api/reports/inventory-movement?from=2026-02-10&to=2026-02-10")).body.rows).toEqual([]);
    expect((await accountant.get("/api/reports/inventory-movement?from=bad&to=2026-02-28")).status).toBe(400);
    expect((await accountant.get("/api/reports/inventory-movement?from=2026-02-30&to=2026-03-01")).status).toBe(400);
    expect((await accountant.get("/api/reports/inventory-movement?from=2026-03-01&to=2026-02-01")).status).toBe(400);
  });
});
