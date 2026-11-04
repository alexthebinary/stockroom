import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";

async function setup() {
  const company = await sampleCompany();
  const { admin, ids } = company;
  const a = ok(await admin.post("/api/items", { sku: "BND-A", name: "Part A" })).body;
  const b = ok(await admin.post("/api/items", { sku: "BND-B", name: "Part B" })).body;
  const gain = async (itemId: number, qty: number, unitCostCents: number) =>
    ok(await admin.post("/api/adjustments", { itemId, warehouseId: ids.warehouse, qty, unitCostCents, reason: "test stock" }));
  await gain(a.id, 10, 1000);
  await gain(a.id, 10, 2000); // average 1500
  await gain(b.id, 5, 700);
  return { ...company, a, b };
}

describe("virtual bundles", () => {
  it("computes availability, ships at average cost with one balanced entry, and keeps the books sound", async () => {
    const { admin, ids, a, b } = await setup();
    const created = ok(await admin.post("/api/bundles", { sku: "KIT-1", name: "Kit", priceCents: 9900, components: [{ itemId: a.id, qty: 2 }, { itemId: b.id, qty: 1 }] })).body;
    expect(created.isBundle).toBe(true);
    expect(created.components.map((c: { sku: string; qty: number }) => [c.sku, c.qty])).toEqual([["BND-A", 2], ["BND-B", 1]]);
    expect(created.available).toBe(5); // min(floor(20/2), floor(5/1))
    expect(created.warehouses.find((w: { warehouseId: number }) => w.warehouseId === ids.warehouse).available).toBe(5);
    expect(await testDb().stockBalance.count({ where: { itemId: created.id } })).toBe(0);

    const listed = ok(await admin.get("/api/items?search=KIT-1")).body;
    expect(listed[0]).toMatchObject({ sku: "KIT-1", isBundle: true, available: 5, priceCents: 9900 });
    expect(ok(await admin.get(`/api/bundles/${created.id}`)).body.available).toBe(5);

    const entriesBefore = await testDb().journalEntry.count({ where: { event: "BUNDLE_SHIPPED" } });
    const shipped = ok(await admin.post(`/api/bundles/${created.id}/ship`, { warehouseId: ids.warehouse, qty: 2, reference: "Order 1001" })).body;
    expect(shipped.valueCents).toBe(4 * 1500 + 2 * 700);
    expect(shipped.components.map((c: { qty: number; valueCents: number }) => [c.qty, c.valueCents])).toEqual([[4, 6000], [2, 1400]]);
    const db = testDb();
    const balance = async (itemId: number) => (await db.stockBalance.findFirstOrThrow({ where: { itemId, warehouseId: ids.warehouse } })).onHand;
    expect(await balance(a.id)).toBe(16);
    expect(await balance(b.id)).toBe(3);

    const entries = await db.journalEntry.findMany({ where: { event: "BUNDLE_SHIPPED" }, include: { lines: { include: { account: true } } } });
    expect(entries.length).toBe(entriesBefore + 1);
    const lines = entries[0]!.lines;
    const sum = (code: string, side: string) => lines.filter((l) => l.account.code === code && l.side === side).reduce((s, l) => s + l.amountCents, 0);
    expect(sum("5000", "DEBIT")).toBe(7400);
    expect(sum("1200", "CREDIT")).toBe(7400);
    expect(lines.length).toBe(4);
    expect(ok(await admin.get(`/api/bundles/${created.id}`)).body.available).toBe(3);
    await expectBooksSound();
  });

  it("refuses to ship more than can be made, posting nothing", async () => {
    const { admin, ids, a, b } = await setup();
    const bundle = ok(await admin.post("/api/bundles", { sku: "KIT-2", name: "Kit 2", components: [{ itemId: a.id, qty: 2 }, { itemId: b.id, qty: 1 }] })).body;
    const db = testDb();
    const movements = await db.stockMovement.count();
    const entries = await db.journalEntry.count();
    const res = await admin.post(`/api/bundles/${bundle.id}/ship`, { warehouseId: ids.warehouse, qty: 6, reference: "Too many" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Part B");
    expect(await db.stockMovement.count()).toBe(movements);
    expect(await db.journalEntry.count()).toBe(entries);
    expect((await admin.post(`/api/bundles/${bundle.id}/ship`, { warehouseId: ids.warehouse, qty: 1, reference: "x" })).status).toBe(400);
    await expectBooksSound();
  });

  it("refuses serial, bundle and duplicate components, and an empty recipe", async () => {
    const { admin, ids, a } = await setup();
    const serial = await admin.post("/api/bundles", { sku: "KIT-3", name: "Kit 3", components: [{ itemId: ids.robot, qty: 1 }] });
    expect(serial.status).toBe(400);
    expect(serial.body.error).toContain("serial");
    const bundle = ok(await admin.post("/api/bundles", { sku: "KIT-4", name: "Kit 4", components: [{ itemId: a.id, qty: 1 }] })).body;
    expect((await admin.post("/api/bundles", { sku: "KIT-5", name: "Nested", components: [{ itemId: bundle.id, qty: 1 }] })).status).toBe(400);
    expect((await admin.post("/api/bundles", { sku: "KIT-6", name: "Dup", components: [{ itemId: a.id, qty: 1 }, { itemId: a.id, qty: 2 }] })).status).toBe(400);
    expect((await admin.post("/api/bundles", { sku: "KIT-7", name: "Empty", components: [] })).status).toBe(400);
    expect(await testDb().item.count({ where: { sku: { in: ["KIT-3", "KIT-5", "KIT-6", "KIT-7"] } } })).toBe(0);
  });

  it("edits the recipe and is flagged so receiving screens can leave bundles out", async () => {
    const { admin, ids, a, b } = await setup();
    const bundle = ok(await admin.post("/api/bundles", { sku: "KIT-8", name: "Kit 8", components: [{ itemId: a.id, qty: 1 }] })).body;
    const patched = ok(await admin.patch(`/api/bundles/${bundle.id}`, { name: "Kit eight", priceCents: 500, components: [{ itemId: b.id, qty: 2 }] })).body;
    expect(patched).toMatchObject({ name: "Kit eight", priceCents: 500, available: 2 });
    expect(patched.components).toHaveLength(1);
    const items = ok(await admin.get("/api/items")).body as { sku: string; isBundle: boolean }[];
    const receivable = items.filter((i) => !i.isBundle).map((i) => i.sku);
    expect(receivable).not.toContain("KIT-8");
    expect(receivable).toContain("BND-A");
    expect((await admin.patch(`/api/bundles/${ids.widget}`, { name: "nope" })).status).toBe(404);
  });
});
