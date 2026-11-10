import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

describe("reorder", () => {
  it("lists items at or under the minimum and creates one draft purchase order per vendor", async () => {
    const { admin, clerk, ids } = await sampleCompany();
    const other = ok(await admin.post("/api/vendors", { name: "Other Supply", kind: "SUPPLIER" })).body;

    ok(await admin.put(`/api/items/${ids.widget}`, { reorderPoint: 10, reorderQty: 3, lastCostCents: 4321 }));
    await testDb().stockBalance.create({ data: { itemId: ids.widget, warehouseId: ids.warehouse, onHand: 4 } });
    ok(await admin.post("/api/purchase-orders", {
      vendorId: ids.supplier,
      warehouseId: ids.warehouse,
      lines: [{ itemId: ids.widget, qtyOrdered: 1, unitCostCents: 4321 }],
    }));

    const enough = ok(await admin.post("/api/items", {
      sku: "ENOUGH",
      name: "Enough on order",
      reorderPoint: 5,
      reorderQty: 5,
      defaultVendorId: ids.supplier,
      lastCostCents: 100,
    })).body;
    ok(await admin.post("/api/purchase-orders", {
      vendorId: ids.supplier,
      warehouseId: ids.warehouse,
      lines: [{ itemId: enough.id, qtyOrdered: 6, unitCostCents: 100 }],
    }));

    const partial = ok(await admin.post("/api/items", {
      sku: "PARTIAL",
      name: "Partly received",
      reorderPoint: 5,
      reorderQty: 1,
      defaultVendorId: ids.supplier,
      lastCostCents: 700,
    })).body;
    const partialPo = ok(await admin.post("/api/purchase-orders", {
      vendorId: ids.supplier,
      warehouseId: ids.warehouse,
      lines: [{ itemId: partial.id, qtyOrdered: 10, unitCostCents: 700 }],
    })).body;
    const received = await deliver(clerk, { warehouseId: ids.warehouse, poId: partialPo.id }, [{ itemId: partial.id, qty: 6 }]);
    expect(received.submitted.status, JSON.stringify(received.submitted.body)).toBe(200);

    const bolt = ok(await admin.post("/api/items", {
      sku: "BOLT",
      name: "Bolt",
      reorderPoint: 2,
      reorderQty: 8,
      defaultVendorId: other.id,
      lastCostCents: 250,
    })).body;
    await testDb().stockBalance.create({ data: { itemId: bolt.id, warehouseId: ids.warehouse, onHand: 2 } });

    const orphan = ok(await admin.post("/api/items", {
      sku: "ORPHAN",
      name: "Orphan part",
      reorderPoint: 1,
      lastCostCents: 10,
    })).body;

    const bundle = ok(await admin.post("/api/bundles", {
      sku: "KIT-1",
      name: "Kit",
      components: [{ itemId: ids.widget, qty: 1 }],
    })).body;
    ok(await admin.put(`/api/items/${bundle.id}`, { reorderPoint: 4, reorderQty: 4 }));
    ok(await admin.put(`/api/items/${ids.robot}`, { reorderPoint: 5, reorderQty: 1 }));
    expect(ok(await admin.get(`/api/items/${ids.robot}`)).body).toMatchObject({ trackingMode: "SERIAL", reorderPoint: 5, lastCostCents: 120000 });
    expect(ok(await admin.get(`/api/items/${ids.widget}`)).body).toMatchObject({ reorderPoint: 10, reorderQty: 3, lastCostCents: 4321, trackingMode: "NONE" });

    const rows = ok(await admin.get("/api/reports/reorder")).body.rows as {
      item: { id: number; sku: string; name: string; lastCostCents: number };
      onHand: number;
      onOrder: number;
      reorderPoint: number;
      reorderQty: number | null;
      suggestedQty: number;
      vendor: { id: number; name: string } | null;
    }[];
    expect(rows.map((row) => row.item.sku)).toEqual(["BOLT", "ORPHAN", "PARTIAL", "SAMPLE-WIDGET"]);
    expect(rows.find((row) => row.item.sku === "SAMPLE-WIDGET")).toMatchObject({
      onHand: 4, onOrder: 1, reorderPoint: 10, reorderQty: 3, suggestedQty: 5,
      vendor: { id: ids.supplier, name: "Sample Supplier Co." },
    });
    expect(rows.find((row) => row.item.sku === "PARTIAL")).toMatchObject({ onHand: 0, onOrder: 4, suggestedQty: 1 });
    expect(rows.find((row) => row.item.sku === "BOLT")).toMatchObject({
      onHand: 2, onOrder: 0, reorderPoint: 2, reorderQty: 8, suggestedQty: 8, vendor: { id: other.id },
    });
    expect(rows.find((row) => row.item.sku === "ORPHAN")).toMatchObject({ vendor: null, reorderQty: null, suggestedQty: 1 });

    const created = ok(await admin.post("/api/reports/reorder", {
      itemIds: rows.map((row) => row.item.id),
      warehouseId: ids.warehouse,
    })).body as { orders: { id: number; number: string; vendorId: number }[]; skipped: { name: string; sku: string; reason: string }[] };
    expect(created.orders.map((order) => order.vendorId).sort()).toEqual([ids.supplier, other.id].sort());
    expect(created.orders).toHaveLength(2);
    expect(created.skipped).toEqual([{ itemId: orphan.id, name: "Orphan part", sku: "ORPHAN", reason: "no vendor" }]);

    const drafts = await testDb().purchaseOrder.findMany({
      where: { id: { in: created.orders.map((order) => order.id) } },
      include: { lines: true },
      orderBy: { id: "asc" },
    });
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.lifecycle).toBe("OPEN");
      expect(draft.billingStatus).toBe("NOT_BILLED");
      expect(draft.receivingStatus).toBe("NOT_RECEIVED");
      expect(draft.source).toBe("MANUAL");
    }
    const supplierPo = drafts.find((draft) => draft.vendorId === ids.supplier);
    const otherPo = drafts.find((draft) => draft.vendorId === other.id);
    expect(supplierPo?.lines.map((line) => [line.itemId, line.qtyOrdered, line.unitCostCents])).toEqual([
      [partial.id, 1, 700],
      [ids.widget, 5, 4321],
    ]);
    expect(otherPo?.lines.map((line) => [line.itemId, line.qtyOrdered, line.unitCostCents])).toEqual([[bolt.id, 8, 250]]);
    expect(new Set(drafts.map((draft) => draft.number)).size).toBe(2);
    expect(drafts.every((draft) => /^PO-\d{5}$/.test(draft.number))).toBe(true);
  });
});
