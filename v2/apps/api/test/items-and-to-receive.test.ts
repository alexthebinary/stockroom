import { describe, expect, it } from "vitest";
import { ok, sampleCompany } from "./helpers";
import { deliver } from "./scan";

describe("beta feedback #6: brand and category on items", () => {
  it("saves them on the item, filters by them, searches them, and a partial update leaves them alone", async () => {
    const { admin, accountant, ids } = await sampleCompany();
    const saved = ok(await admin.put(`/api/items/${ids.widget}`, { brand: " XAG ", category: "Chargers" })).body;
    expect(saved).toMatchObject({ brand: "XAG", category: "Chargers" });
    ok(await admin.put(`/api/items/${ids.robot}`, { brand: "Unitree", category: "Robots" }));

    const skus = async (query: string) => (ok(await accountant.get(`/api/items${query}`)).body as { sku: string }[]).map((i) => i.sku);
    expect(await skus("?brand=XAG")).toEqual(["SAMPLE-WIDGET"]);
    expect(await skus("?category=Robots")).toEqual(["SAMPLE-ROBOT"]);
    expect(await skus("?brand=XAG&category=Robots")).toEqual([]);
    expect(await skus("?search=unitree")).toEqual(["SAMPLE-ROBOT"]);

    expect(ok(await accountant.get("/api/items/facets")).body).toEqual({ brands: ["Unitree", "XAG"], categories: ["Chargers", "Robots"] });

    ok(await admin.put(`/api/items/${ids.widget}`, { name: "Widget, renamed" }));
    expect(ok(await accountant.get(`/api/items/${ids.widget}`)).body).toMatchObject({ name: "Widget, renamed", brand: "XAG", category: "Chargers" });
    ok(await admin.put(`/api/items/${ids.widget}`, { brand: "" }));
    expect(ok(await accountant.get(`/api/items/${ids.widget}`)).body.brand).toBeNull();
  });
});

describe("beta feedback #5: inventory to receive", () => {
  it("lists ordered-not-arrived units, billed or not, and drops them once received", async () => {
    const { admin, clerk, accountant, ids } = await sampleCompany();
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: ids.widget, qtyOrdered: 5, unitCostCents: 40000 }] })).body;
    const draft = ok(await accountant.post("/api/bills", { poId: po.id })).body;
    const edited = ok(await accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "INV-1" })).body;
    ok(await accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));

    const before = ok(await accountant.get("/api/reports/to-receive")).body;
    expect(before).toMatchObject({ totalUnits: 5, totalValueCents: 200000 });
    expect(before.orders[0]).toMatchObject({ poId: po.id, billingStatus: "BILLED", units: 5 });
    expect(before.orders[0].lines[0]).toMatchObject({ ordered: 5, received: 0, outstanding: 5, billed: true });

    await deliver(clerk, { warehouseId: ids.warehouse, poId: po.id }, [{ code: "012345678905", qty: 2 }]);
    const partial = ok(await accountant.get("/api/reports/to-receive")).body;
    expect(partial).toMatchObject({ totalUnits: 3, totalValueCents: 120000 });
    expect(partial.orders[0].lines[0]).toMatchObject({ received: 2, outstanding: 3 });

    await deliver(clerk, { warehouseId: ids.warehouse, poId: po.id }, [{ code: "012345678905", qty: 3 }]);
    expect(ok(await accountant.get("/api/reports/to-receive")).body).toMatchObject({ orders: [], totalUnits: 0 });
  });
});
