import { describe, expect, it } from "vitest";
import { ok, sampleCompany } from "./helpers";
import { deliver } from "./scan";

describe("list endpoints the screens read", () => {
  it("bills, orders, expected deliveries, receipts, registers and reports all answer after a delivery", async () => {
    const c = await sampleCompany();
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: "012345678905", qty: 2 }]);
    const bills = ok(await c.accountant.get("/api/bills")).body;
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ status: "DRAFT", heldUnits: 2, vendor: { id: c.ids.supplier } });
    const bill = ok(await c.accountant.get(`/api/bills/${bills[0].id}`)).body;
    expect(bill.preview.lines).toHaveLength(1);
    expect(bill.lines[0].item.sku).toBe("SAMPLE-WIDGET");
    expect(ok(await c.admin.get("/api/purchase-orders?lifecycle=ALL")).body).toHaveLength(1);
    expect(ok(await c.clerk.get("/api/receiving/expected")).body).toHaveLength(0);
    expect(ok(await c.admin.get("/api/receipts")).body).toHaveLength(1);
    expect(ok(await c.admin.get("/api/registers?register=WH_IN")).body).toHaveLength(1);
    expect(ok(await c.clerk.get("/api/scan-sessions?status=SUBMITTED")).body).toHaveLength(1);
    expect(ok(await c.accountant.get("/api/home")).body.accounting.draftBills).toBe(1);
    ok(await c.accountant.get("/api/payments"));
    ok(await c.accountant.get("/api/journal"));
    ok(await c.accountant.get("/api/posting-rules"));
    ok(await c.accountant.get("/api/items?search=widget"));
    ok(await c.accountant.get(`/api/items/${c.ids.widget}`));
  });
});
