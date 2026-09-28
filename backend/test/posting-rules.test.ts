/**
 * Postings read their accounts from PostingRule rows (Account Assignment,
 * client request 2026-09-28), not from code. Boot seeds a rule only where one
 * is missing, so an admin's choice survives a restart; posted entries never
 * change when a rule does.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import { boot, prisma } from "./helpers";
import { POSTING_ROLES, postRoles, syncPostingRules } from "../src/posting";
import { postSimple } from "../src/ledger";
import { TRANSACTION_TYPE } from "../src/accounts";

beforeAll(async () => {
  await boot();
});

const linesOf = (entryId: number) =>
  prisma.journalLine.findMany({ where: { journalEntryId: entryId }, include: { account: true }, orderBy: { id: "asc" } });

describe("posting rules", () => {
  it("boot gives every role of every transaction type a rule", async () => {
    const rules = await prisma.postingRule.findMany();
    for (const [type, roles] of Object.entries(POSTING_ROLES)) {
      for (const r of roles) {
        expect(rules.find((x) => x.transactionType === type && x.role === r.role), `${type}.${r.role}`).toBeTruthy();
      }
    }
  });

  it("a posting uses the rule's account, and changing the rule leaves past entries alone", async () => {
    const post = () =>
      prisma.$transaction((tx) =>
        postSimple(tx, { transactionType: TRANSACTION_TYPE.ADJUSTMENT_DECREASE, amountCents: 100, actor: "test" })
      );
    const first = (await post())!;
    expect((await linesOf(first.id)).map((l) => l.account.code)).toEqual(["6000", "1200"]);

    const rounding = await prisma.account.findUniqueOrThrow({ where: { code: "5200" } });
    await prisma.postingRule.update({
      where: { transactionType_role: { transactionType: "ADJUSTMENT_DECREASE", role: "debit" } },
      data: { accountId: rounding.id },
    });
    const second = (await post())!;
    expect((await linesOf(second.id)).map((l) => l.account.code)).toEqual(["5200", "1200"]);
    expect((await linesOf(first.id)).map((l) => l.account.code)).toEqual(["6000", "1200"]);
  });

  it("boot does not overwrite an edited rule", async () => {
    await syncPostingRules();
    const rule = await prisma.postingRule.findUniqueOrThrow({
      where: { transactionType_role: { transactionType: "ADJUSTMENT_DECREASE", role: "debit" } },
      include: { account: true },
    });
    expect(rule.account.code).toBe("5200");
  });

  it("refuses a role the transaction type does not have", async () => {
    await expect(
      prisma.$transaction((tx) =>
        postRoles(tx, { transactionType: TRANSACTION_TYPE.OPENING_BALANCE, amounts: { nonsense: 5 }, actor: "test" })
      )
    ).rejects.toThrow(/OPENING_BALANCE.*nonsense/);
  });
});
