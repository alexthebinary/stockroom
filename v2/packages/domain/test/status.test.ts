import { describe, expect, it } from "vitest";
import { assertTransition, billingStatus, paymentStatus, receiptState, receivingStatus } from "../src";

describe("purchase order axes (WMS doc: created, billed, paid/unpaid, received/partially received)", () => {
  it("billing follows the bills", () => {
    expect(billingStatus([])).toBe("NOT_BILLED");
    expect(billingStatus([{ status: "VOID" }])).toBe("NOT_BILLED");
    expect(billingStatus([{ status: "DRAFT" }])).toBe("DRAFT");
    expect(billingStatus([{ status: "DRAFT" }, { status: "POSTED" }])).toBe("BILLED");
  });

  it("payment follows what is owed and what was paid", () => {
    expect(paymentStatus(0, 0), "a bill credited back in full owes nothing").toBe("PAID");
    expect(paymentStatus(110000, 0)).toBe("UNPAID");
    expect(paymentStatus(110000, 60000)).toBe("PARTIAL");
    expect(paymentStatus(110000, 110000)).toBe("PAID");
  });

  it("receiving counts physical arrival, held units included", () => {
    expect(receivingStatus([{ qtyOrdered: 2, qtyReceived: 0 }])).toBe("NOT_RECEIVED");
    expect(receivingStatus([{ qtyOrdered: 2, qtyReceived: 1 }, { qtyOrdered: 1, qtyReceived: 1 }])).toBe("PARTIAL");
    expect(receivingStatus([{ qtyOrdered: 2, qtyReceived: 3 }])).toBe("RECEIVED");
    expect(receivingStatus([])).toBe("NOT_RECEIVED");
  });
});

describe("warehouse receipt", () => {
  it("is pending until its units land against a bill", () => {
    expect(receiptState([{ qty: 2, landedQty: 0 }])).toBe("PENDING_BILL");
    expect(receiptState([{ qty: 2, landedQty: 1 }])).toBe("PARTIAL");
    expect(receiptState([{ qty: 2, landedQty: 2 }, { qty: 1, landedQty: 1 }])).toBe("POSTED");
  });
});

describe("transitions", () => {
  it("allows the documented ones and refuses the rest with a 409", () => {
    expect(() => assertTransition("bill", "DRAFT", "POSTED")).not.toThrow();
    expect(() => assertTransition("bill", "POSTED", "VOID")).not.toThrow();
    expect(() => assertTransition("scanSession", "OPEN", "SUBMITTED")).not.toThrow();
    try {
      assertTransition("bill", "VOID", "POSTED");
      expect.fail("should refuse");
    } catch (error) {
      expect((error as { status: number }).status).toBe(409);
    }
    expect(() => assertTransition("scanSession", "SUBMITTED", "OPEN")).toThrow(/cannot go from SUBMITTED to OPEN/);
  });
});
