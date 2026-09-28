/**
 * The client's revised chart of accounts (2026-09-28 screenshots).
 *
 * Renumbering must move history with the account: journal lines point at the
 * account id, so a balance grouped by id is identical before and after. The
 * sync runs on every boot, so a second run must be a no-op, and it must never
 * undo an admin's rename.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { syncChartOfAccounts } from "../src/accounts";
import { createEntry } from "../src/ledger";

async function balancesById() {
  const lines = await prisma.journalLine.groupBy({
    by: ["accountId"],
    _sum: { debitCents: true, creditCents: true },
  });
  return Object.fromEntries(
    lines.map((l) => [l.accountId, (l._sum.debitCents ?? 0) - (l._sum.creditCents ?? 0)])
  );
}

const byCode = async (code: string) => prisma.account.findUnique({ where: { code } });

beforeAll(async () => {
  await boot();
});

describe("revised chart of accounts", () => {
  it("renumbers the three moved accounts, keeps their history, and adds the new ones", async () => {
    // Rebuild the pre-revision chart: drop the accounts the revision adds (no
    // history on a fresh test DB), then put the three moved accounts back at
    // their old codes. Works whether or not the revision already ran at boot.
    const added = ["Sales Tax Payable", "Sales Tax Transition", "Shipping Income", "Freight-In",
      "Freight-Out", "Customer Goods", "Customer Goods Payable"];
    const addedRows = await prisma.account.findMany({ where: { name: { in: added } } });
    const rules = (prisma as unknown as { postingRule?: { deleteMany: (a: object) => Promise<unknown> } }).postingRule;
    if (rules) await rules.deleteMany({ where: { accountId: { in: addedRows.map((a) => a.id) } } });
    await prisma.account.deleteMany({ where: { id: { in: addedRows.map((a) => a.id) } } });
    for (const [now, old] of [["2150", "2100"], ["4200", "4100"], ["6000", "5100"]] as const) {
      const row = await byCode(now);
      if (row) await prisma.account.update({ where: { id: row.id }, data: { code: old } });
    }
    await prisma.account.update({ where: { code: "2100" }, data: { name: "Customer Deposits" } });

    const ids = {
      deposits: (await byCode("2100"))!.id,
      gain: (await byCode("4100"))!.id,
      loss: (await byCode("5100"))!.id,
    };
    await prisma.$transaction((tx) =>
      createEntry(tx, {
        transactionType: "OPENING_BALANCE",
        actor: "test",
        lines: [
          { accountCode: "5100", debitCents: 700 },
          { accountCode: "4100", creditCents: 300 },
          { accountCode: "2100", creditCents: 400 },
        ],
      })
    );
    const before = await balancesById();

    await syncChartOfAccounts();
    const second = await syncChartOfAccounts();

    expect(await balancesById()).toEqual(before);
    expect(await prisma.account.findUniqueOrThrow({ where: { id: ids.deposits } }))
      .toMatchObject({ code: "2150", name: "Customer Deposits (retired)" });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: ids.gain } }))
      .toMatchObject({ code: "4200", name: "Inventory Adjustment Gain" });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: ids.loss } }))
      .toMatchObject({ code: "6000", name: "Inventory Adjustment Loss" });
    const expected: [string, string, string][] = [
      ["2100", "Sales Tax Payable", "LIABILITY"],
      ["2200", "Sales Tax Transition", "LIABILITY"],
      ["4100", "Shipping Income", "INCOME"],
      ["5100", "Freight-In", "EXPENSE"],
      ["6100", "Freight-Out", "EXPENSE"],
      ["9000", "Customer Goods", "OFF_BALANCE"],
      ["9100", "Customer Goods Payable", "OFF_BALANCE"],
    ];
    for (const [code, name, accountType] of expected) {
      expect(await byCode(code), code).toMatchObject({ name, accountType });
    }
    expect(second).toEqual([]);
  });

  it("does not undo an admin's rename on the next boot", async () => {
    await prisma.account.update({ where: { code: "1000" }, data: { name: "Operating Bank" } });
    await syncChartOfAccounts();
    expect((await byCode("1000"))!.name).toBe("Operating Bank");
  });

  it("refuses to boot when a renumber was skipped and an old account still holds a new code", async () => {
    // e.g. 2100 still "Customer Deposits" because its new code was taken: the
    // new Sales Tax Payable would never be created and tax would post onto
    // the old deposits account. Fail loudly instead.
    const payable = await byCode("2100");
    await prisma.account.update({ where: { id: payable!.id }, data: { name: "Customer Deposits" } });
    await expect(syncChartOfAccounts()).rejects.toThrow(/2100.*Customer Deposits/);
    await prisma.account.update({ where: { id: payable!.id }, data: { name: "Sales Tax Payable" } });
  });
});
