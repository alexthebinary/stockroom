import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

/** Inventory Asset (1200), the part a role tags: on hand, or billed and in transit. */
async function inventory(role: "inventoryOnHand" | "inventoryInbound") {
  const lines = await testDb().journalLine.findMany({ where: { role } });
  return lines.reduce((s, l) => s + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0);
}

const WIDGET = "012345678905"; // the sample widget's UPC-A
const ROBOT = "012345678912";

async function balances(code: string) {
  const db = testDb();
  const accounts = await db.account.findMany({ include: { lines: true } });
  const a = accounts.find((x) => x.code === code)!;
  return a.lines.reduce((s, l) => s + (l.side === a.normalSide ? l.amountCents : -l.amountCents), 0);
}

async function stock(itemId: number) {
  const db = testDb();
  const [balance, pool] = await Promise.all([db.stockBalance.findFirst({ where: { itemId } }), db.costPool.findUnique({ where: { itemId } })]);
  return { onHand: balance?.onHand ?? 0, held: balance?.held ?? 0, poolQty: pool?.qty ?? 0, poolValue: pool?.valueCents ?? 0 };
}

describe("scan first, bill after (the clerk's surprise delivery)", () => {
  it("opens a PO, a draft bill and a pending receipt; units are held, nothing is valued or posted", async () => {
    const { clerk, ids } = await sampleCompany();
    const { submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET }, { code: WIDGET }]);
    ok(submitted);
    expect(submitted.body).toMatchObject({ landedUnits: 0, heldUnits: 2 });
    const db = testDb();
    const po = await db.purchaseOrder.findFirstOrThrow({ include: { lines: true } });
    expect(po).toMatchObject({ source: "SCAN", vendorId: ids.supplier, billingStatus: "DRAFT", receivingStatus: "RECEIVED", paymentStatus: "UNPAID" });
    expect(po.lines[0]).toMatchObject({ qtyOrdered: 2, qtyReceived: 2, qtyHeld: 2, unitCostCents: 50000 });
    const bill = await db.vendorBill.findFirstOrThrow({ include: { lines: true } });
    expect(bill).toMatchObject({ status: "DRAFT", source: "SCAN", vendorId: ids.supplier, totalCents: 100000 });
    expect((await db.warehouseReceipt.findFirstOrThrow()).state).toBe("PENDING_BILL");
    expect(await stock(ids.widget)).toEqual({ onHand: 0, held: 2, poolQty: 0, poolValue: 0 });
    expect(await db.journalEntry.count()).toBe(0);
    await expectBooksSound();
  });

  it("posting the bill with $100 freight lands them at $550 each (GAAP guide §I.4)", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET, qty: 2 }]);
    const bill = (await testDb().vendorBill.findFirstOrThrow());
    const edited = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorInvoiceNumber: "SS-INV-1001", freightCents: 10000 })).body;
    const preview = ok(await accountant.get(`/api/bills/${bill.id}/preview`)).body;
    expect(preview.lines[0]).toMatchObject({ goodsCents: 100000, freightCents: 10000, landedCents: 110000, landedUnitCents: 55000 });
    expect(preview.landing[0]).toMatchObject({ units: 2, valueCents: 110000 });
    ok(await accountant.post(`/api/bills/${bill.id}/post`, { version: edited.version }));

    expect(await stock(ids.widget)).toEqual({ onHand: 2, held: 0, poolQty: 2, poolValue: 110000 });
    expect(await inventory("inventoryOnHand")).toBe(110000);
    expect(await inventory("inventoryInbound")).toBe(0);
    expect(await balances("2000")).toBe(110000);
    const db = testDb();
    expect((await db.warehouseReceipt.findFirstOrThrow()).state).toBe("POSTED");
    const po = await db.purchaseOrder.findFirstOrThrow();
    expect(po).toMatchObject({ billingStatus: "BILLED", receivingStatus: "RECEIVED", paymentStatus: "UNPAID" });
    // The WH-IN register: held in against the PO, then out of held and into stock against the bill.
    const moves = await db.stockMovement.findMany({ orderBy: { id: "asc" } });
    expect(moves.map((m) => [m.register, m.bucket, m.qtyDelta, m.counterType])).toEqual([
      ["WH_IN", "HELD", 2, "PO"],
      ["WH_IN", "HELD", -2, "BILL"],
      ["WH_IN", "ON_HAND", 2, "BILL"],
    ]);
    await expectBooksSound();
  });

  it("a bill for 1 of 2 held units lands 1 and keeps 1 held", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET, qty: 2 }]);
    const bill = await testDb().vendorBill.findFirstOrThrow({ include: { lines: true } });
    const edited = ok(
      await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorInvoiceNumber: "A-1", lines: [{ id: bill.lines[0]!.id, qty: 1, unitCostCents: 50000 }] }),
    ).body;
    ok(await accountant.post(`/api/bills/${bill.id}/post`, { version: edited.version }));
    expect(await stock(ids.widget)).toEqual({ onHand: 1, held: 1, poolQty: 1, poolValue: 50000 });
    expect((await testDb().warehouseReceipt.findFirstOrThrow()).state).toBe("PARTIAL");
    // The rest gets a fresh draft when the next bill is needed.
    const po = await testDb().purchaseOrder.findFirstOrThrow();
    expect(po.billingStatus).toBe("BILLED");
    await expectBooksSound();
  });

  it("a delivery from an unknown vendor waits for accounting to name the vendor before the bill posts", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    await deliver(clerk, { warehouseId: ids.warehouse }, [{ code: WIDGET }]);
    const bill = await testDb().vendorBill.findFirstOrThrow();
    expect(bill.vendorId).toBeNull();
    const refused = await accountant.post(`/api/bills/${bill.id}/post`, { version: bill.version });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/vendor/);
    const edited = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorId: ids.supplier, vendorInvoiceNumber: "X-9" })).body;
    expect(edited.termsDays).toBe(30);
    expect((await testDb().purchaseOrder.findFirstOrThrow()).vendorId).toBe(ids.supplier);
    ok(await accountant.post(`/api/bills/${bill.id}/post`, { version: edited.version }));
    await expectBooksSound();
  });
});

describe("bill first, goods after (the WMS doc's order: PO → Bill → Receipt)", () => {
  it("bill posts to inventory in transit; boxes land one at a time and clear it exactly", async () => {
    const { admin, clerk, accountant, ids } = await sampleCompany();
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: ids.widget, qtyOrdered: 3, unitCostCents: 33333 }] })).body;
    expect(await testDb().journalEntry.count(), "a PO posts nothing").toBe(0);
    const draft = ok(await accountant.post("/api/bills", { poId: po.id })).body;
    const edited = ok(await accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "INV-3", freightCents: 1 })).body;
    ok(await accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));
    expect(await inventory("inventoryInbound")).toBe(100000);
    expect(await balances("2000")).toBe(100000);
    expect((await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).receivingStatus).toBe("NOT_RECEIVED");

    const values = [];
    for (let i = 0; i < 3; i++) {
      const { submitted } = await deliver(clerk, { warehouseId: ids.warehouse, poId: po.id }, [{ code: WIDGET }]);
      expect(ok(submitted).body).toMatchObject({ landedUnits: 1, heldUnits: 0, draftBillIds: [] });
      values.push((await testDb().receiptLine.findFirstOrThrow({ orderBy: { id: "desc" } })).valueCents);
    }
    expect(values).toEqual([33333, 33334, 33333]);
    expect(await inventory("inventoryInbound")).toBe(0);
    expect(await stock(ids.widget)).toEqual({ onHand: 3, held: 0, poolQty: 3, poolValue: 100000 });
    expect((await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).receivingStatus).toBe("RECEIVED");
    await expectBooksSound();
  });

  it("extras that arrive with a billed PO go to a new PO and a draft bill, held", async () => {
    const { admin, clerk, accountant, ids } = await sampleCompany();
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: ids.widget, qtyOrdered: 2, unitCostCents: 50000 }] })).body;
    const draft = ok(await accountant.post("/api/bills", { poId: po.id })).body;
    const edited = ok(await accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "INV-2" })).body;
    ok(await accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));
    const { submitted } = await deliver(clerk, { warehouseId: ids.warehouse, poId: po.id }, [
      { code: WIDGET, qty: 3 },
      { code: `(01)00${ROBOT}(21)SN-0001` },
    ]);
    expect(ok(submitted).body).toMatchObject({ landedUnits: 2, heldUnits: 2 });
    const pos = await testDb().purchaseOrder.findMany({ include: { lines: true }, orderBy: { id: "asc" } });
    expect(pos).toHaveLength(2);
    expect(pos[1]).toMatchObject({ source: "SCAN", billingStatus: "DRAFT", vendorId: ids.supplier });
    expect(pos[1]!.lines.map((l) => [l.itemId, l.qtyHeld, l.addedAtDock])).toEqual([
      [ids.widget, 1, true],
      [ids.robot, 1, true],
    ]);
    const serial = await testDb().serialUnit.findFirstOrThrow();
    expect(serial).toMatchObject({ serial: "SN-0001", state: "HELD" });
    await expectBooksSound();
  });

  it("extras on a PO that is not billed yet simply grow the order", async () => {
    const { admin, clerk, ids } = await sampleCompany();
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: ids.widget, qtyOrdered: 1, unitCostCents: 50000 }] })).body;
    await deliver(clerk, { warehouseId: ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    const line = await testDb().purchaseOrderLine.findFirstOrThrow({ where: { poId: po.id } });
    expect(line).toMatchObject({ qtyOrdered: 2, qtyReceived: 2, qtyHeld: 2 });
    expect(await testDb().purchaseOrder.count()).toBe(1);
  });
});

describe("scanning is safe to repeat", () => {
  it("replaying the same events adds nothing; finishing twice is refused; scanning after finishing is refused", async () => {
    const { clerk, ids } = await sampleCompany();
    const session = ok(await clerk.post("/api/scan-sessions", { clientId: randomUUID(), warehouseId: ids.warehouse, vendorId: ids.supplier })).body;
    const events = [1, 2].map(() => ({ clientId: randomUUID(), code: WIDGET, qty: 1, source: "BARCODE", capturedAt: new Date().toISOString() }));
    ok(await clerk.post(`/api/scan-sessions/${session.id}/events`, { events }));
    ok(await clerk.post(`/api/scan-sessions/${session.id}/events`, { events }));
    ok(await clerk.post(`/api/scan-sessions/${session.id}/events`, { events: [events[0]] }));
    expect(await testDb().scanEvent.count()).toBe(2);
    const tooFew = await clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: 3 });
    expect(tooFew.status).toBe(409);
    ok(await clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: 2 }));
    expect((await clerk.post(`/api/scan-sessions/${session.id}/submit`, { expectedEventCount: 2 })).status).toBe(409);
    const late = await clerk.post(`/api/scan-sessions/${session.id}/events`, { events: [{ ...events[0], clientId: randomUUID() }] });
    expect(late.status).toBe(409);
    expect((await stock(ids.widget)).held).toBe(2);
  });

  it("starting the same delivery twice returns the same session", async () => {
    const { clerk, ids } = await sampleCompany();
    const clientId = randomUUID();
    const a = ok(await clerk.post("/api/scan-sessions", { clientId, warehouseId: ids.warehouse })).body;
    const b = ok(await clerk.post("/api/scan-sessions", { clientId, warehouseId: ids.warehouse })).body;
    expect(a.id).toBe(b.id);
  });

  it("a correction is a negative scan", async () => {
    const { clerk, ids } = await sampleCompany();
    const { submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET, qty: 3 }, { code: WIDGET, qty: -1 }]);
    expect(ok(submitted).body.heldUnits).toBe(2);
  });
});

describe("serial-tracked items", () => {
  it("need a serial per unit, refuse a serial twice, and go in stock when the bill posts", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    const missing = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: ROBOT }]);
    expect(missing.submitted.status).toBe(400);
    expect(missing.submitted.body.error).toMatch(/serial/);

    ok((await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: ROBOT, serial: "SN-0001" }, { code: `(01)00${ROBOT}(21)SN-0002` }])).submitted);
    const again = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: ROBOT, serial: "SN-0001" }]);
    expect(again.submitted.status).toBe(409);

    const bill = await testDb().vendorBill.findFirstOrThrow({ where: { status: "DRAFT" } });
    const edited = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorInvoiceNumber: "R-1" })).body;
    ok(await accountant.post(`/api/bills/${bill.id}/post`, { version: edited.version }));
    const serials = await testDb().serialUnit.findMany({ orderBy: { serial: "asc" } });
    expect(serials.map((s) => [s.serial, s.state])).toEqual([
      ["SN-0001", "IN_STOCK"],
      ["SN-0002", "IN_STOCK"],
    ]);
    await expectBooksSound();
  });
});

describe("unknown barcodes never block the clerk", () => {
  it("are kept aside with no stock, then mapped by accounting, which learns the barcode and receives them", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    const { session, submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [
      { code: WIDGET },
      { code: "NEW-THING-77", unknownName: "Blue box, no label", qty: 2 },
    ]);
    expect(ok(submitted).body.unknown).toEqual([{ code: "NEW-THING-77", name: "Blue box, no label", qty: 2 }]);
    expect((await stock(ids.widget)).held).toBe(1);
    const queue = ok(await accountant.get("/api/receiving/unknown")).body;
    expect(queue).toHaveLength(1);
    ok(await accountant.post(`/api/scan-sessions/${session.id}/resolve`, { code: "NEW-THING-77", itemId: ids.openBox }));
    expect((await stock(ids.openBox)).held).toBe(2);
    expect(ok(await accountant.get("/api/receiving/unknown")).body).toHaveLength(0);
    const lookup = ok(await clerk.get("/api/lookup?code=NEW-THING-77")).body;
    expect(lookup.match.itemId).toBe(ids.openBox);
    await expectBooksSound();
  });
});

describe("bill desk rules", () => {
  it("refuses a stale edit and a vendor invoice number already booked", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET }]);
    let bill = await testDb().vendorBill.findFirstOrThrow();
    const first = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorInvoiceNumber: "DUP-1" })).body;
    expect((await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, notes: "stale" })).status).toBe(409);
    ok(await accountant.post(`/api/bills/${bill.id}/post`, { version: first.version }));

    await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET }]);
    bill = await testDb().vendorBill.findFirstOrThrow({ where: { status: "DRAFT" } });
    const second = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, vendorInvoiceNumber: "dup-1" })).body;
    const refused = await accountant.post(`/api/bills/${bill.id}/post`, { version: second.version });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/already on BILL-/);
  });

  it("sets the due date from the bill date and terms", async () => {
    const { clerk, accountant, ids } = await sampleCompany();
    await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier }, [{ code: WIDGET }]);
    const bill = await testDb().vendorBill.findFirstOrThrow();
    const edited = ok(await accountant.patch(`/api/bills/${bill.id}`, { version: bill.version, billDate: "2026-10-01", termsDays: 15 })).body;
    expect(new Date(edited.dueDate).toISOString().slice(0, 10)).toBe("2026-10-16");
  });
});
