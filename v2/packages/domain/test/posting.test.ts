import { describe, expect, it } from "vitest";
import {
  CHART,
  DEFAULT_ROLE_ACCOUNTS,
  landedCost,
  planEntry,
  receiptValue,
  type PlannedLine,
} from "../src";

/**
 * The GAAP guide states entries against "Inventory Asset". v2 books the two
 * children (1201 On Hand, 1202 Inbound); statements roll them up. So each
 * golden test resolves roles to accounts, rolls children into their parent,
 * and nets — and must then read exactly like the guide.
 */
function asTheGuideReadsIt(...entries: PlannedLine[][]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const line of entries.flat()) {
    const code = DEFAULT_ROLE_ACCOUNTS[line.role];
    const account = CHART.find((a) => a.code === code)!;
    const shown = account.parent ? CHART.find((a) => a.code === account.parent)! : account;
    const signed = line.side === "DEBIT" ? line.amountCents : -line.amountCents;
    net[shown.name] = (net[shown.name] ?? 0) + signed;
  }
  return Object.fromEntries(Object.entries(net).filter(([, v]) => v !== 0));
}

const dr = (n: number) => n * 100;
const cr = (n: number) => -n * 100;

// Section II.1 of the guide: 2 widgets @ $500, $100 inbound freight, $550 landed.
const [widgets] = landedCost([{ key: "widget", qty: 2, unitCostCents: 50000 }], 10000, "VALUE");

describe("GAAP guide §II.1 — Vendor Bill, Inventory (purchase cycle)", () => {
  it("1. Bill, no freight: Dr Inventory Asset 1,000 / Cr AP 1,000", () => {
    const bill = planEntry("BILL_POSTED", [
      { role: "inventoryInbound", itemId: 1, amountCents: 100000 },
      { role: "payable", vendorId: 1, amountCents: 100000 },
    ]);
    expect(asTheGuideReadsIt(bill)).toEqual({ "Inventory Asset": dr(1000), "Accounts Payable": cr(1000) });
  });

  it("2. Bill with inbound freight: Dr Inventory Asset 1,100 / Cr AP 1,100, and the receipt only moves it within Inventory Asset", () => {
    const bill = planEntry("BILL_POSTED", [
      { role: "inventoryInbound", itemId: 1, amountCents: widgets!.landedCents },
      { role: "payable", vendorId: 1, amountCents: widgets!.landedCents },
    ]);
    const receipt = planEntry("RECEIPT_LANDED", [
      { role: "inventoryOnHand", itemId: 1, amountCents: receiptValue(widgets!.landedCents, 2, 0, 2) },
      { role: "inventoryInbound", itemId: 1, amountCents: receiptValue(widgets!.landedCents, 2, 0, 2) },
    ]);
    expect(asTheGuideReadsIt(bill)).toEqual({ "Inventory Asset": dr(1100), "Accounts Payable": cr(1100) });
    expect(asTheGuideReadsIt(bill, receipt)).toEqual({ "Inventory Asset": dr(1100), "Accounts Payable": cr(1100) });
  });

  it("3. Full purchase return (bill unpaid): Dr AP 1,100 / Cr Inventory Asset 1,100", () => {
    const ret = planEntry("PURCHASE_RETURN", [
      { role: "payable", vendorId: 1, amountCents: 110000 },
      { role: "inventoryOnHand", itemId: 1, amountCents: 110000 },
    ]);
    expect(asTheGuideReadsIt(ret)).toEqual({ "Accounts Payable": dr(1100), "Inventory Asset": cr(1100) });
  });

  it("4. Partial return, 1 unit (bill unpaid): Dr AP 550 / Cr Inventory Asset 550", () => {
    const ret = planEntry("PURCHASE_RETURN", [
      { role: "payable", vendorId: 1, amountCents: 55000 },
      { role: "inventoryOnHand", itemId: 1, amountCents: 55000 },
    ]);
    expect(asTheGuideReadsIt(ret)).toEqual({ "Accounts Payable": dr(550), "Inventory Asset": cr(550) });
  });

  it("5. Bill payment: Dr AP 1,100 / Cr Bank 1,100", () => {
    const pay = planEntry("BILL_PAYMENT", [
      { role: "payable", vendorId: 1, amountCents: 110000 },
      { role: "bank", amountCents: 110000 },
    ]);
    expect(asTheGuideReadsIt(pay)).toEqual({ "Accounts Payable": dr(1100), "Bank / Cash": cr(1100) });
  });

  it("6. Full return after payment: the return, then the vendor's cash refund", () => {
    const ret = planEntry("PURCHASE_RETURN", [
      { role: "payable", vendorId: 1, amountCents: 110000 },
      { role: "inventoryOnHand", itemId: 1, amountCents: 110000 },
    ]);
    const refund = planEntry("VENDOR_REFUND", [
      { role: "bank", amountCents: 110000 },
      { role: "payable", vendorId: 1, amountCents: 110000 },
    ]);
    expect(asTheGuideReadsIt(ret)).toEqual({ "Accounts Payable": dr(1100), "Inventory Asset": cr(1100) });
    expect(asTheGuideReadsIt(refund)).toEqual({ "Bank / Cash": dr(1100), "Accounts Payable": cr(1100) });
  });

  it("7. Partial return after payment, 1 unit: 550 each step", () => {
    const refund = planEntry("VENDOR_REFUND", [
      { role: "bank", amountCents: 55000 },
      { role: "payable", vendorId: 1, amountCents: 55000 },
    ]);
    expect(asTheGuideReadsIt(refund)).toEqual({ "Bank / Cash": dr(550), "Accounts Payable": cr(550) });
  });

  it("8. Purchase price discount on one item: Dr AP 200 / Cr Inventory Asset 200", () => {
    const allowance = planEntry("VENDOR_PRICE_ALLOWANCE", [
      { role: "payable", vendorId: 1, amountCents: 20000 },
      { role: "inventoryOnHand", amountCents: 20000, itemId: 1 },
    ]);
    expect(asTheGuideReadsIt(allowance)).toEqual({ "Accounts Payable": dr(200), "Inventory Asset": cr(200) });
  });
});

describe("GAAP guide §II.1 — Freight bills from a third-party carrier", () => {
  it("Freight-In: Dr Inventory Asset 100 / Cr AP 100", () => {
    const freight = planEntry("FREIGHT_IN_POSTED", [
      { role: "inventoryInbound", itemId: 1, amountCents: 10000 },
      { role: "payable", vendorId: 1, amountCents: 10000 },
    ]);
    expect(asTheGuideReadsIt(freight)).toEqual({ "Inventory Asset": dr(100), "Accounts Payable": cr(100) });
  });

  it("Freight-In after one of two units sold: half to stock, half to COGS", () => {
    const freight = planEntry("FREIGHT_IN_POSTED", [
      { role: "inventoryOnHand", itemId: 1, amountCents: 5000 },
      { role: "cogs", amountCents: 5000 },
      { role: "payable", vendorId: 1, amountCents: 10000 },
    ]);
    expect(asTheGuideReadsIt(freight)).toEqual({
      "Inventory Asset": dr(50),
      "Cost of Goods Sold": dr(50),
      "Accounts Payable": cr(100),
    });
  });

  it("Freight-Out: Dr Outbound Shipping Expense 45 / Cr AP 45", () => {
    const freight = planEntry("FREIGHT_OUT_POSTED", [
      { role: "outboundShipping", amountCents: 4500 },
      { role: "payable", vendorId: 1, amountCents: 4500 },
    ]);
    expect(asTheGuideReadsIt(freight)).toEqual({ "Outbound Shipping Expense": dr(45), "Accounts Payable": cr(45) });
  });
});

describe("GAAP guide §II.3 — Opening balance", () => {
  it("Dr Inventory Asset 3,000 / Cr Opening Balance Equity 3,000", () => {
    const opening = planEntry("OPENING_STOCK", [
      { role: "inventoryOnHand", amountCents: 300000, itemId: 7 },
      { role: "openingEquity", amountCents: 300000 },
    ]);
    expect(asTheGuideReadsIt(opening)).toEqual({ "Inventory Asset": dr(3000), "Opening Balance Equity": cr(3000) });
  });
});

describe("planEntry", () => {
  it("puts a negative amount on the opposite side (return variance either way)", () => {
    const lines = planEntry("PURCHASE_RETURN", [
      { role: "payable", vendorId: 1, amountCents: 50000 },
      { role: "inventoryOnHand", itemId: 1, amountCents: 55000 },
      { role: "returnVariance", amountCents: -5000 },
    ]);
    expect(lines.find((l) => l.role === "returnVariance")).toMatchObject({ side: "DEBIT", amountCents: 5000 });
  });

  it("drops zero lines and keeps dimensions", () => {
    const lines = planEntry("FREIGHT_IN_POSTED", [
      { role: "inventoryInbound", amountCents: 0, itemId: 1 },
      { role: "inventoryOnHand", amountCents: 100, itemId: 1, poLineId: 9 },
      { role: "payable", amountCents: 100, vendorId: 3 },
    ]);
    expect(lines).toEqual([
      { role: "inventoryOnHand", side: "DEBIT", amountCents: 100, itemId: 1, poLineId: 9 },
      { role: "payable", side: "CREDIT", amountCents: 100, vendorId: 3 },
    ]);
  });

  it("refuses an unbalanced entry, a role the event does not use, and fractions of a cent", () => {
    expect(() =>
      planEntry("BILL_PAYMENT", [
        { role: "payable", vendorId: 1, amountCents: 100 },
        { role: "bank", amountCents: 99 },
      ]),
    ).toThrow(/does not balance/);
    expect(() => planEntry("BILL_PAYMENT", [{ role: "cogs", amountCents: 1 }])).toThrow(/does not use/);
    expect(() => planEntry("BILL_PAYMENT", [{ role: "bank", amountCents: 0.5 }])).toThrow(/whole cents/);
  });

  it("refuses an inventory line without its item and a payables line without its vendor", () => {
    expect(() =>
      planEntry("OPENING_STOCK", [
        { role: "inventoryOnHand", amountCents: 100 },
        { role: "openingEquity", amountCents: 100 },
      ]),
    ).toThrow(/name its item/);
    expect(() =>
      planEntry("BILL_PAYMENT", [
        { role: "payable", amountCents: 100 },
        { role: "bank", amountCents: 100 },
      ]),
    ).toThrow(/name its vendor/);
  });
});

describe("chart of accounts", () => {
  it("has every account the GAAP guide names", () => {
    const names = CHART.map((a) => a.name);
    for (const name of [
      "Bank / Cash",
      "Accounts Receivable",
      "Inventory Asset",
      "Accounts Payable",
      "Sales Tax Payable",
      "Opening Balance Equity",
      "Sales Revenue",
      "Shipping & Handling Revenue",
      "Sales Returns & Allowances",
      "Sales Returns & Allowances – Shipping/Handling",
      "Inventory Adjustment Gain",
      "Cost of Goods Sold",
      "Outbound Shipping Expense",
      "Inventory Adjustment Loss",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("maps every role to a posting (non-header) account", () => {
    for (const code of Object.values(DEFAULT_ROLE_ACCOUNTS)) {
      const account = CHART.find((a) => a.code === code);
      expect(account, code).toBeDefined();
      expect(account!.header, code).toBeFalsy();
    }
  });
});
