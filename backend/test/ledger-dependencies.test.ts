/**
 * SEQUENCE 1 of 3: unpost a journal entry that a payment depends on.
 *
 * Why this one matters: `unpostEntry` drops an entry out of every POSTED-filtered
 * report, the trial balance included. If it succeeds while a payment still stands
 * against the bill, the payment references money the books no longer show. The
 * guard exists (ledger.ts:249 -> dependenciesOf, ledger.ts:170). Nothing proved it
 * fires until now.
 *
 * ⚠️ setup MUST be imported first — it sets DATABASE_URL, and src/db.ts constructs
 * PrismaClient at import time. Any src/ import above this line binds the dev DB.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db";
import { dependenciesOf, postSimple, unpostEntry } from "../src/ledger";
import { syncChartOfAccounts } from "../src/accounts";
import { ensureDocumentCounters } from "../src/numbering";

let vendorId: number;

beforeAll(async () => {
  await syncChartOfAccounts();
  await ensureDocumentCounters();
  const vendor = await prisma.vendor.create({
    data: { name: "Test Vendor Co", email: "vendor@test.local" },
  });
  vendorId = vendor.id;
});

/**
 * ⚠️ TWO INDEPENDENT GUARDS protect unposting, discovered while writing this:
 *   1. `dependenciesOf` (ledger.ts:170) — a payment or a reversal stands against it.
 *   2. `postedDocumentFor` (ledger.ts:264) — the OWNING DOCUMENT is still posted,
 *      "so the money vanishes from every report while the paperwork insists it
 *      happened."
 * They fire in that order. To exercise guard 1 in isolation the bill must be
 * POSTED; to exercise neither, the bill must be SAVED. `billStatus` selects which.
 */
async function billWithPostedEntry(billNumber: string, cents: number, billStatus = "POSTED") {
  const bill = await prisma.bill.create({
    data: { billNumber, vendorId, totalCents: cents, subtotalCents: cents, status: billStatus },
  });
  const entry = await prisma.$transaction((tx) =>
    postSimple(tx, {
      transactionType: "PURCHASE_BILL",
      amountCents: cents,
      referenceType: "BILL",
      referenceId: bill.id,
      actor: "test@local",
    })
  );
  expect(entry, "postSimple should return an entry for a non-zero amount").not.toBeNull();
  return { bill, entry: entry! };
}

describe("unposting an entry a payment depends on", () => {
  it("blocks unposting while the owning document is still posted", async () => {
    // Guard 2, in isolation: no payment exists, so dependenciesOf returns null,
    // and the block must come from the document status alone.
    const { entry } = await billWithPostedEntry("BILL-DOC-1", 3_300, "POSTED");
    const blocker = await prisma.$transaction((tx) => dependenciesOf(tx, entry));
    expect(blocker, "no payment yet, so guard 1 must be silent").toBeNull();

    await expect(
      prisma.$transaction((tx) => unpostEntry(tx, entry.id))
    ).rejects.toThrow(/still posted/i);
  });

  it("allows unposting while nothing depends on the entry", async () => {
    // The CONTROL. Without it, a test that only asserts the block could pass
    // because unposting is broken for every entry, which would look identical.
    const { entry } = await billWithPostedEntry("BILL-CTRL-1", 5_000, "SAVED");
    const blocker = await prisma.$transaction((tx) => dependenciesOf(tx, entry));
    expect(blocker).toBeNull();

    const after = await prisma.$transaction((tx) => unpostEntry(tx, entry.id));
    expect(after.status).toBe("SAVED");
    expect(after.postedAt).toBeNull();
  });

  it("refuses to unpost once a payment stands against the bill", async () => {
    const { bill, entry } = await billWithPostedEntry("BILL-DEP-1", 12_345);

    await prisma.payment.create({
      data: {
        paymentNumber: "PAY-DEP-1",
        direction: "OUT",
        amountCents: 12_345,
        billId: bill.id,
        vendorId,
        status: "SAVED",
      },
    });

    const blocker = await prisma.$transaction((tx) => dependenciesOf(tx, entry));
    expect(blocker).toBe("a payment has been made against this bill");

    await expect(
      prisma.$transaction((tx) => unpostEntry(tx, entry.id))
    ).rejects.toThrow(/cannot be unposted/i);

    // The entry must be untouched — a rejected unpost that still mutated status
    // would be worse than one that succeeded, because nothing would report it.
    const still = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(still.status).toBe("POSTED");
    expect(still.postedAt).not.toBeNull();
  });

  it("ignores a VOID payment, which is not a dependency", async () => {
    // dependenciesOf filters `status: { not: "VOID" }`. If that filter were
    // dropped, a voided payment would permanently freeze a correctable entry.
    const { bill, entry } = await billWithPostedEntry("BILL-VOID-1", 7_700);
    await prisma.payment.create({
      data: {
        paymentNumber: "PAY-VOID-1",
        direction: "OUT",
        amountCents: 7_700,
        billId: bill.id,
        vendorId,
        status: "VOID",
      },
    });

    const blocker = await prisma.$transaction((tx) => dependenciesOf(tx, entry));
    expect(blocker).toBeNull();
  });
});
