import { describe, expect, it } from "vitest";
import { expectBooksSound, ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

/** Inventory Asset (1200), the part a role tags: on hand, or billed and in transit. */
async function inventory(role: "inventoryOnHand" | "inventoryInbound") {
  const lines = await testDb().journalLine.findMany({ where: { role } });
  return lines.reduce((s, l) => s + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0);
}

const WIDGET = "012345678905";
type Company = Awaited<ReturnType<typeof sampleCompany>>;

async function balance(code: string) {
  const a = await testDb().account.findUniqueOrThrow({ where: { code }, include: { lines: true } });
  return a.lines.reduce((s, l) => s + (l.side === a.normalSide ? l.amountCents : -l.amountCents), 0);
}
const pool = (itemId: number) => testDb().costPool.findUniqueOrThrow({ where: { itemId } });

/** PO for `qty` widgets at $500, billed (optionally with freight on the bill), nothing received yet. */
async function billedPo(c: Company, qty: number, freightCents = 0, invoice = "INV-1") {
  const po = ok(await c.admin.post("/api/purchase-orders", { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: c.ids.widget, qtyOrdered: qty, unitCostCents: 50000 }] })).body;
  const draft = ok(await c.accountant.post("/api/bills", { poId: po.id })).body;
  const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: invoice, freightCents })).body;
  const bill = ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version })).body;
  return { po, bill };
}

async function freightBill(c: Company, poIds: number[], amountCents: number, invoice = "FR-1") {
  const draft = ok(await c.accountant.post("/api/freight-bills", { kind: "FREIGHT_IN", vendorId: c.ids.carrier, vendorInvoiceNumber: invoice, amountCents, targetPoIds: poIds })).body;
  return ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: draft.version })).body;
}

describe("Vendor Bill – Freight-In from a third-party carrier (GAAP guide §II.1)", () => {
  it("posted before the goods arrive: they land at $550 each", async () => {
    const c = await sampleCompany();
    const { po } = await billedPo(c, 2);
    const freight = await freightBill(c, [po.id], 10000);
    expect(freight.allocations[0]).toMatchObject({ amountCents: 10000, inboundCents: 10000, onHandCents: 0, soldCents: 0 });
    expect(await inventory("inventoryInbound")).toBe(110000);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 2, valueCents: 110000 });
    expect(await inventory("inventoryInbound")).toBe(0);
    expect(await balance("2000")).toBe(110000);
    await expectBooksSound();
  });

  it("posted after they arrived, none sold: Dr Inventory 100, average becomes $550", async () => {
    const c = await sampleCompany();
    const { po } = await billedPo(c, 2);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    await freightBill(c, [po.id], 10000);
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 2, valueCents: 110000 });
    expect(await inventory("inventoryOnHand")).toBe(110000);
    await expectBooksSound();
  });

  it("posted after 1 of 2 left stock: $50 to the unit still here, $50 to cost of goods sold", async () => {
    const c = await sampleCompany();
    const { po } = await billedPo(c, 2);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    ok(await c.clerk.post("/api/adjustments", { itemId: c.ids.widget, warehouseId: c.ids.warehouse, qty: -1, reason: "Dropped off the forklift" }));
    const freight = await freightBill(c, [po.id], 10000);
    expect(freight.allocations[0]).toMatchObject({ inboundCents: 0, onHandCents: 5000, soldCents: 5000 });
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 1, valueCents: 55000 });
    expect(await balance("5000")).toBe(5000);
    await expectBooksSound();
  });

  it("spreads one freight bill over two orders by value", async () => {
    const c = await sampleCompany();
    const a = await billedPo(c, 1, 0, "A");
    const b = await billedPo(c, 3, 0, "B");
    const freight = await freightBill(c, [a.po.id, b.po.id], 10000);
    expect(freight.allocations.map((x: { amountCents: number }) => x.amountCents)).toEqual([2500, 7500]);
    await expectBooksSound();
  });

  it("voids a freight bill against today's stock and the books stay sound", async () => {
    const c = await sampleCompany();
    const { po } = await billedPo(c, 2);
    const freight = await freightBill(c, [po.id], 10000);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    ok(await c.accountant.post(`/api/bills/${freight.id}/void`));
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 2, valueCents: 100000 });
    expect(await balance("2000")).toBe(100000);
    await expectBooksSound();
  });
});

describe("Vendor Bill – Freight-Out (GAAP guide §II.1)", () => {
  it("Dr Outbound Shipping Expense 45 / Cr AP 45, no stock touched", async () => {
    const c = await sampleCompany();
    const draft = ok(await c.accountant.post("/api/freight-bills", { kind: "FREIGHT_OUT", vendorId: c.ids.carrier, vendorInvoiceNumber: "OUT-1", amountCents: 4500 })).body;
    ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: draft.version }));
    expect(await balance("6100")).toBe(4500);
    expect(await balance("2000")).toBe(4500);
    await expectBooksSound();
  });
});

describe("Vendor credits (GAAP guide §II.1 #3, #4, #6, #7, #8)", () => {
  async function landedBill(c: Company) {
    const { po, bill } = await billedPo(c, 2, 10000);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    return ok(await c.accountant.get(`/api/bills/${bill.id}`)).body;
  }

  it("#4 partial return, bill unpaid: Dr AP 550 / Cr Inventory 550", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    const credit = ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: bill.lines[0].id, qty: 1 }] })).body;
    expect(credit.totalCents).toBe(55000);
    expect(await balance("2000")).toBe(55000);
    expect(await inventory("inventoryOnHand")).toBe(55000);
    expect(await balance("5000"), "no variance when credit = average").toBe(0);
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 1, valueCents: 55000 });
    const out = await testDb().stockMovement.findFirstOrThrow({ where: { register: "WH_OUT" } });
    expect(out).toMatchObject({ qtyDelta: -1, counterType: "VENDOR_CREDIT", valueCents: 55000 });
    await expectBooksSound();
  });

  it("#3 full return, bill unpaid: AP and inventory both go to zero and the bill reads settled", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: bill.lines[0].id, qty: 2 }] }));
    expect(await balance("2000")).toBe(0);
    expect(await inventory("inventoryOnHand")).toBe(0);
    expect((await testDb().purchaseOrder.findFirstOrThrow()).paymentStatus).toBe("PAID");
    await expectBooksSound();
  });

  it("#6 full return after payment: the return, then the vendor's refund", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 110000 }));
    expect(await balance("1000")).toBe(-110000);
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: bill.lines[0].id, qty: 2 }] }));
    expect(await balance("2000"), "the vendor owes us").toBe(-110000);
    expect((await c.accountant.post(`/api/bills/${bill.id}/refunds`, { amountCents: 110001 })).status).toBe(409);
    ok(await c.accountant.post(`/api/bills/${bill.id}/refunds`, { amountCents: 110000 }));
    expect(await balance("2000")).toBe(0);
    expect(await balance("1000")).toBe(0);
    await expectBooksSound();
  });

  it("#7 partial return after payment: 550 and 550", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 110000 }));
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: bill.lines[0].id, qty: 1 }] }));
    ok(await c.accountant.post(`/api/bills/${bill.id}/refunds`, { amountCents: 55000 }));
    expect(await balance("1000")).toBe(-55000);
    expect(await inventory("inventoryOnHand")).toBe(55000);
    await expectBooksSound();
  });

  it("a credit that differs from average cost books the difference to COGS", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: bill.lines[0].id, qty: 1, amountCents: 50000 }] }));
    expect(await balance("2000")).toBe(60000);
    expect(await balance("5000"), "freight the vendor won't refund").toBe(5000);
    await expectBooksSound();
  });

  it("billed units that never arrived come off inventory in transit", async () => {
    const c = await sampleCompany();
    const { po, bill } = await billedPo(c, 2, 10000);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET }]);
    const full = ok(await c.accountant.get(`/api/bills/${bill.id}`)).body;
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "RETURN", lines: [{ billLineId: full.lines[0].id, qty: 1, received: false }] }));
    expect(await inventory("inventoryInbound")).toBe(0);
    expect(await balance("2000")).toBe(55000);
    const after = await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.receivingStatus).toBe("RECEIVED");
    await expectBooksSound();
  });

  it("#8 price discount on one item: Dr AP 200 / Cr Inventory 200, and the average drops", async () => {
    const c = await sampleCompany();
    const bill = await landedBill(c);
    ok(await c.accountant.post(`/api/bills/${bill.id}/credits`, { kind: "PRICE_ALLOWANCE", lines: [{ billLineId: bill.lines[0].id, amountCents: 20000 }] }));
    expect(await balance("2000")).toBe(90000);
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 2, valueCents: 90000 });
    await expectBooksSound();
  });
});

describe("Payments (GAAP guide §II.1 #5)", () => {
  it("pays in part then in full, refuses overpaying, and a void puts it back", async () => {
    const c = await sampleCompany();
    const { po, bill } = await billedPo(c, 2, 10000);
    const first = ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 60000, method: "ACH" })).body;
    expect((await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).paymentStatus).toBe("PARTIAL");
    expect((await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 50001 })).status).toBe(409);
    ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 50000 }));
    expect((await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).paymentStatus).toBe("PAID");
    expect(await balance("2000")).toBe(0);
    ok(await c.accountant.post(`/api/payments/${first.id}/void`));
    expect((await c.accountant.post(`/api/payments/${first.id}/void`)).status).toBe(409);
    expect(await balance("2000")).toBe(60000);
    expect((await testDb().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).paymentStatus).toBe("PARTIAL");
    await expectBooksSound();
  });
});

describe("Voiding an inventory bill", () => {
  it("sends its landed units back to awaiting a bill, with a fresh draft", async () => {
    const c = await sampleCompany();
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: WIDGET, qty: 2 }]);
    const draft = await testDb().vendorBill.findFirstOrThrow();
    const edited = ok(await c.accountant.patch(`/api/bills/${draft.id}`, { version: draft.version, vendorInvoiceNumber: "WRONG-PRICE", freightCents: 10000 })).body;
    ok(await c.accountant.post(`/api/bills/${draft.id}/post`, { version: edited.version }));
    ok(await c.accountant.post(`/api/bills/${draft.id}/void`));
    const balanceRow = await testDb().stockBalance.findFirstOrThrow();
    expect(balanceRow).toMatchObject({ onHand: 0, held: 2 });
    expect(await pool(c.ids.widget)).toMatchObject({ qty: 0, valueCents: 0 });
    expect(await balance("2000")).toBe(0);
    const drafts = await testDb().vendorBill.findMany({ where: { status: "DRAFT" } });
    expect(drafts).toHaveLength(1);
    expect((await testDb().purchaseOrder.findFirstOrThrow()).billingStatus).toBe("DRAFT");
    expect((await testDb().warehouseReceipt.findFirstOrThrow()).state).toBe("PENDING_BILL");
    // The same invoice number can be booked again once the wrong bill is void.
    const redo = ok(await c.accountant.patch(`/api/bills/${drafts[0]!.id}`, { version: drafts[0]!.version, vendorInvoiceNumber: "WRONG-PRICE" })).body;
    ok(await c.accountant.post(`/api/bills/${drafts[0]!.id}/post`, { version: redo.version }));
    await expectBooksSound();
  });

  it("is refused with a payment on it, or once its units have left stock", async () => {
    const c = await sampleCompany();
    const { po, bill } = await billedPo(c, 2);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    const payment = ok(await c.accountant.post(`/api/bills/${bill.id}/payments`, { amountCents: 100 })).body;
    expect((await c.accountant.post(`/api/bills/${bill.id}/void`)).status).toBe(409);
    ok(await c.accountant.post(`/api/payments/${payment.id}/void`));
    ok(await c.clerk.post("/api/adjustments", { itemId: c.ids.widget, warehouseId: c.ids.warehouse, qty: -1, reason: "Damaged in storage" }));
    expect((await c.accountant.post(`/api/bills/${bill.id}/void`)).status).toBe(409);
    await expectBooksSound();
  });
});

describe("Reports", () => {
  it("trial balance balances, valuation matches the ledger, AP ages by due date, held stock is listed", async () => {
    const c = await sampleCompany();
    const { po } = await billedPo(c, 2, 10000);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, poId: po.id }, [{ code: WIDGET, qty: 2 }]);
    await deliver(c.clerk, { warehouseId: c.ids.warehouse, vendorId: c.ids.supplier }, [{ code: WIDGET }]);
    const tb = ok(await c.accountant.get("/api/reports/trial-balance")).body;
    expect(tb.totalDebitCents).toBe(tb.totalCreditCents);
    expect(tb.rows.find((r: { code: string }) => r.code === "1200").debitCents, "header rolls up").toBe(110000);
    const valuation = ok(await c.accountant.get("/api/reports/valuation")).body;
    expect(valuation.rows[0]).toMatchObject({ sku: "SAMPLE-WIDGET", onHand: 2, held: 1, valueCents: 110000, averageCents: 55000, varianceCents: 0 });
    const aging = ok(await c.accountant.get(`/api/reports/ap-aging?asOf=${new Date(Date.now() + 45 * 86_400_000).toISOString()}`)).body;
    expect(aging.vendors[0]).toMatchObject({ totalCents: 110000, "1-30": 110000 });
    const held = ok(await c.accountant.get("/api/reports/held")).body;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ qtyHeld: 1, estimateCents: 50000 });
    const home = ok(await c.accountant.get("/api/home")).body;
    expect(home.accounting).toMatchObject({ draftBills: 1, heldUnits: 1, payableCents: 110000 });
    expect(home.admin.booksSound).toBe(true);
  });
});

describe("the general journal", () => {
  it("lists entries newest first, filters by kind, and shows each entry's debits before its credits", async () => {
    const c = await sampleCompany();
    const { bill } = await billedPo(c, 2);
    await freightBill(c, [bill.poId], 10000);
    const all = ok(await c.accountant.get("/api/journal")).body as { event: string; lines: { side: string }[] }[];
    expect(all.map((e) => e.event)).toEqual(["FREIGHT_IN_POSTED", "BILL_POSTED"]);
    const bills = ok(await c.accountant.get("/api/journal?event=BILL_POSTED")).body as { lines: { side: string; amountCents: number; role: string; account: { code: string } }[] }[];
    expect(bills).toHaveLength(1);
    expect(bills[0]!.lines.map((l) => [l.side, l.account.code, l.role, l.amountCents])).toEqual([
      ["DEBIT", "1200", "inventoryInbound", 100000],
      ["CREDIT", "2000", "payable", 100000],
    ]);
    expect(ok(await c.accountant.get("/api/journal?take=1&skip=1")).body[0].event).toBe("BILL_POSTED");
  });
});
