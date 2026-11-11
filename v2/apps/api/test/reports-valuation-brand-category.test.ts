import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb } from "./helpers";

describe("feedback #40: valuation report rows carry brand and category", () => {
  it("returns each item's brand and category (null when unset)", async () => {
    const { admin, accountant, ids } = await sampleCompany();
    ok(await admin.put(`/api/items/${ids.widget}`, { brand: "XAG", category: "Chargers" }));
    for (const itemId of [ids.widget, ids.robot]) await testDb().stockBalance.create({ data: { itemId, warehouseId: ids.warehouse, onHand: 3 } });
    const { rows } = ok(await accountant.get("/api/reports/valuation")).body as { rows: { itemId: number; brand: string | null; category: string | null }[] };
    expect(rows.find((r) => r.itemId === ids.widget)).toMatchObject({ brand: "XAG", category: "Chargers" });
    expect(rows.find((r) => r.itemId === ids.robot)).toMatchObject({ brand: null, category: null });
  });
});
