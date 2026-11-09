import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  BILL_STATES,
  billingStatus,
  FEEDBACK_AUTO_STATES,
  FEEDBACK_SPEC_STATES,
  FEEDBACK_STATUSES,
  MACHINES,
  PAYMENT_STATES,
  paymentStatus,
  PO_LIFECYCLE_FILTERS,
  PO_LIFECYCLE_STATES,
  receiptState,
  receivingStatus,
  refusalMessage,
  SCAN_STATES,
  SERIAL_STATES,
  sourcesFor,
} from "../src";

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

describe("declared machines", () => {
  const lists = {
    bill: BILL_STATES,
    payment: PAYMENT_STATES,
    scanSession: SCAN_STATES,
    poLifecycle: PO_LIFECYCLE_STATES,
    serialUnit: SERIAL_STATES,
    feedbackStatus: FEEDBACK_STATUSES,
    feedbackSpec: FEEDBACK_SPEC_STATES,
    feedbackAuto: FEEDBACK_AUTO_STATES,
  } as const;

  it("exports each machine's states, and every edge stays inside them", () => {
    for (const [name, list] of Object.entries(lists)) {
      const machine = MACHINES[name as keyof typeof MACHINES];
      expect([...list], name).toEqual(Object.keys(machine.edges));
      expect(list, name).toContain(machine.initial);
      for (const targets of Object.values(machine.edges)) {
        for (const target of targets) expect(list, `${name} → ${target}`).toContain(target);
      }
    }
  });

  it("describes the writes that exist: no CLOSED purchase order, cancel is idempotent", () => {
    expect(sourcesFor("poLifecycle", "CANCELED")).toEqual(["OPEN", "CANCELED"]);
    expect(PO_LIFECYCLE_STATES).not.toContain("CLOSED");
    expect(PO_LIFECYCLE_FILTERS).toEqual(["OPEN", "CANCELED", "CLOSED", "ALL"]);
    expect(() => assertTransition("poLifecycle", "CANCELED", "CANCELED")).not.toThrow();
    expect(sourcesFor("bill", "POSTED")).toEqual(["DRAFT"]);
    expect(sourcesFor("serialUnit", "RETURNED")).toEqual(["IN_STOCK"]);
  });

  it("names the current state and where it can still go", () => {
    expect(refusalMessage("Bill", "VOID", [])).toBe("Bill is void; it is final");
    expect(refusalMessage("Bill", "POSTED", ["VOID"])).toBe("Bill is posted; it can only go to void");
    expect(refusalMessage("Delivery", "OPEN", ["OPEN", "SUBMITTED", "ABANDONED"])).toBe(
      "Delivery is open; it can only go to open, submitted, abandoned",
    );
  });

  it("fails when a state is missing from the state-machines doc", () => {
    const doc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/state-machines.md"), "utf8");
    for (const [name, machine] of Object.entries(MACHINES)) {
      for (const state of Object.keys(machine.edges)) {
        expect(doc.includes(state), `${name} ${state} is not in v2/docs/state-machines.md`).toBe(true);
      }
    }
  });
});
