import { describe, expect, it } from "vitest";
import { matchStatus, priceDriftPercent } from "../src/routes/purchasing";
import { ok, sampleCompany } from "./helpers";

type Note = { text: string; tone: string };
type Match = {
  itemId: number;
  itemName: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyThisBill: number;
  qtyAllBills: number;
  orderUnitCostCents: number;
  billUnitCostCents: number;
  pricePercent: number | null;
  statuses: Note[];
};

const texts = (row: Match) => row.statuses.map((note) => note.text);
const byItem = (body: { match: Match[] }, itemId: number) => body.match.find((row) => row.itemId === itemId)!;

describe("match status wording", () => {
  it("keeps a 1 percent gap as a match and names a wider price gap, over-order, and billing ahead of receipt", () => {
    const base = { qtyOrdered: 4, qtyReceived: 4, qtyAllBills: 4, orderUnitCostCents: 20000 };
    expect(priceDriftPercent(20000, 20200)).toBeNull();
    expect(priceDriftPercent(20000, 20201)).toBe(1.01);
    expect(matchStatus({ ...base, billUnitCostCents: 20200 }).map((note) => note.text)).toEqual(["Matches"]);
    expect(matchStatus({ ...base, billUnitCostCents: 20600 })).toEqual([{ text: "Price differs by +3%", tone: "warn" }]);
    expect(matchStatus({ ...base, billUnitCostCents: 19000 })).toEqual([{ text: "Price differs by -5%", tone: "warn" }]);
    expect(matchStatus({ qtyOrdered: 2, qtyReceived: 2, qtyAllBills: 5, orderUnitCostCents: 5000, billUnitCostCents: 5000 })).toEqual([
      { text: "Billing more than ordered", tone: "warn" },
      { text: "Billing more than received", tone: "note" },
    ]);
    expect(matchStatus({ qtyOrdered: 4, qtyReceived: 0, qtyAllBills: 4, orderUnitCostCents: 10000, billUnitCostCents: 10000 })).toEqual([
      { text: "Billing more than received", tone: "note" },
    ]);
    expect(matchStatus({ qtyOrdered: 1, qtyReceived: 1, qtyAllBills: 1, orderUnitCostCents: 0, billUnitCostCents: 100 })).toEqual([{ text: "Price differs", tone: "warn" }]);
  });
});

describe("GET /api/bills/:id match", () => {
  it("reports a matching line, a price gap over 1 percent, and billing more than ordered", async () => {
    const c = await sampleCompany();
    const gasket = ok(await c.admin.post("/api/items", { sku: "GASKET", name: "Gasket" })).body as { id: number };
    const po = ok(await c.admin.post("/api/purchase-orders", {
      vendorId: c.ids.supplier,
      warehouseId: c.ids.warehouse,
      lines: [
        { itemId: c.ids.widget, qtyOrdered: 4, unitCostCents: 10000 },
        { itemId: c.ids.openBox, qtyOrdered: 4, unitCostCents: 20000 },
        { itemId: gasket.id, qtyOrdered: 2, unitCostCents: 5000 },
      ],
    })).body as { id: number };
    const created = ok(await c.accountant.post("/api/bills", { poId: po.id })).body as { id: number };
    const draft = ok(await c.accountant.get(`/api/bills/${created.id}`)).body as { id: number; version: number; lines: { id: number; itemId: number }[] };
    const lineId = (itemId: number) => draft.lines.find((line) => line.itemId === itemId)!.id;
    ok(await c.accountant.patch(`/api/bills/${draft.id}`, {
      version: draft.version,
      lines: [
        { id: lineId(c.ids.widget), qty: 4, unitCostCents: 10000 },
        { id: lineId(c.ids.openBox), qty: 4, unitCostCents: 20600 },
        { id: lineId(gasket.id), qty: 5, unitCostCents: 5000 },
      ],
    }));
    ok(await c.clerk.post(`/api/purchase-orders/${po.id}/receive`, {
      items: [
        { itemId: c.ids.widget, qty: 4 },
        { itemId: c.ids.openBox, qty: 4 },
        { itemId: gasket.id, qty: 2 },
      ],
    }));

    const got = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { version: number; match: Match[] };
    expect(byItem(got, c.ids.widget)).toMatchObject({
      itemName: "Sample Widget",
      qtyOrdered: 4,
      qtyReceived: 4,
      qtyThisBill: 4,
      qtyAllBills: 4,
      orderUnitCostCents: 10000,
      billUnitCostCents: 10000,
      pricePercent: null,
      statuses: [{ text: "Matches", tone: "ok" }],
    });
    expect(byItem(got, c.ids.openBox)).toMatchObject({
      qtyOrdered: 4,
      qtyReceived: 4,
      qtyThisBill: 4,
      qtyAllBills: 4,
      pricePercent: 3,
      statuses: [{ text: "Price differs by +3%", tone: "warn" }],
    });
    expect(byItem(got, gasket.id)).toMatchObject({
      itemName: "Gasket",
      qtyOrdered: 2,
      qtyReceived: 2,
      qtyThisBill: 5,
      qtyAllBills: 5,
      statuses: [
        { text: "Billing more than ordered", tone: "warn" },
        { text: "Billing more than received", tone: "note" },
      ],
    });

    ok(await c.accountant.patch(`/api/bills/${draft.id}`, {
      version: got.version,
      lines: [{ id: lineId(c.ids.openBox), qty: 4, unitCostCents: 20200 }],
    }));
    const atOnePercent = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { version: number; match: Match[] };
    expect(byItem(atOnePercent, c.ids.openBox).statuses).toEqual([{ text: "Matches", tone: "ok" }]);
    expect(byItem(atOnePercent, c.ids.openBox).pricePercent).toBeNull();

    ok(await c.accountant.patch(`/api/bills/${draft.id}`, {
      version: atOnePercent.version,
      lines: [{ id: lineId(c.ids.openBox), qty: 4, unitCostCents: 19000 }],
    }));
    const under = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { match: Match[] };
    expect(byItem(under, c.ids.openBox)).toMatchObject({ pricePercent: -5, statuses: [{ text: "Price differs by -5%", tone: "warn" }] });
  });

  it("counts every open bill, including a posted one, and skips a voided draft", async () => {
    const c = await sampleCompany();
    const po = ok(await c.admin.post("/api/purchase-orders", {
      vendorId: c.ids.supplier,
      warehouseId: c.ids.warehouse,
      lines: [{ itemId: c.ids.widget, qtyOrdered: 4, unitCostCents: 10000 }],
    })).body as { id: number };
    const discarded = ok(await c.accountant.post("/api/bills", { poId: po.id })).body as { id: number };
    ok(await c.accountant.del(`/api/bills/${discarded.id}`));
    const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body as { id: number };
    const before = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { match: Match[] };
    expect(before.match).toHaveLength(1);
    expect(before.match[0]).toMatchObject({ qtyThisBill: 4, qtyAllBills: 4, qtyReceived: 0 });
    expect(texts(before.match[0]!)).toEqual(["Billing more than received"]);

    ok(await c.clerk.post(`/api/purchase-orders/${po.id}/receive`, { items: [{ itemId: c.ids.widget, qty: 4 }] }));
    const fresh = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { version: number; lines: { id: number }[] };
    const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, {
      version: fresh.version,
      vendorInvoiceNumber: "INV-PART",
      lines: [{ id: fresh.lines[0]!.id, qty: 1, unitCostCents: 10000 }],
    })).body as { version: number };
    ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));
    const rest = ok(await c.accountant.post("/api/bills", { poId: po.id })).body as { id: number };

    const posted = ok(await c.accountant.get(`/api/bills/${draft.id}`)).body as { status: string; match: Match[] };
    const open = ok(await c.accountant.get(`/api/bills/${rest.id}`)).body as { match: Match[] };
    expect(posted.status).toBe("POSTED");
    expect(posted.match[0]).toMatchObject({ qtyThisBill: 1, qtyAllBills: 4, qtyOrdered: 4, qtyReceived: 4, statuses: [{ text: "Matches", tone: "ok" }] });
    expect(open.match[0]).toMatchObject({ qtyThisBill: 3, qtyAllBills: 4, statuses: [{ text: "Matches", tone: "ok" }] });
  });

  it("returns no match for a freight bill", async () => {
    const c = await sampleCompany();
    const freight = ok(await c.accountant.post("/api/freight-bills", {
      kind: "FREIGHT_OUT",
      vendorId: c.ids.carrier,
      vendorInvoiceNumber: "FR-1",
      amountCents: 1500,
    })).body as { id: number };
    const got = ok(await c.accountant.get(`/api/bills/${freight.id}`)).body as { kind: string; poId: number | null; match: Match[] | null };
    expect(got.kind).toBe("FREIGHT_OUT");
    expect(got.poId).toBeNull();
    expect(got.match).toBeNull();
  });
});
