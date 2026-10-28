import { describe, expect, it } from "vitest";
import { ok, sampleCompany, testDb } from "./helpers";

describe("journal filters", () => {
  it("searches entry fields and accounts case-insensitively, keeping complete balanced entries", async () => {
    const { accountant } = await sampleCompany();
    const db = testDb();
    const accounts = await db.account.findMany({ where: { isHeader: false }, take: 2, orderBy: { id: "asc" } });
    const create = (number: string, date: string, memo: string | null, actor: string, event = "BILL_POSTED") => db.journalEntry.create({
      data: { number, date: new Date(date), memo, actor, event, sourceType: "TEST", sourceId: 1,
        lines: { create: accounts.map((account, i) => ({ accountId: account.id, role: "test", side: i ? "CREDIT" : "DEBIT", amountCents: 1234 })) } },
    });
    const before = await create("JE-BEFORE", "2026-01-31T23:59:59.999Z", "Opening", "Ada");
    const first = await create("JE-ALPHA", "2026-02-01T00:00:00.000Z", "Freight charges", "Ada Lovelace");
    const last = await create("JE-OMEGA", "2026-02-28T23:59:59.999Z", null, "Grace Hopper", "PAYMENT_POSTED");
    await create("JE-AFTER", "2026-03-01T00:00:00.000Z", "Later", "Ada");
    const search = async (q: string, extra = "") => ok(await accountant.get(`/api/journal?q=${encodeURIComponent(q)}${extra}`)).body;
    expect((await search(" je-alpha ")).map((e: { id: number }) => e.id)).toEqual([first.id]);
    expect((await search("FREIGHT")).map((e: { id: number }) => e.id)).toEqual([first.id]);
    expect((await search("hopper")).map((e: { id: number }) => e.id)).toEqual([last.id]);
    for (const q of [accounts[0]!.code, accounts[0]!.name.toUpperCase()]) {
      const entries = await search(q, "&from=2026-02-01&to=2026-02-28");
      expect(entries.map((e: { id: number }) => e.id)).toEqual([last.id, first.id]);
      for (const entry of entries) {
        expect(entry.lines).toHaveLength(2);
        expect(entry.lines.map((line: { side: string; amountCents: number }) => [line.side, line.amountCents])).toEqual([["DEBIT", 1234], ["CREDIT", 1234]]);
      }
    }
    expect((await search("", "&from=2026-02-01&to=2026-02-28&take=1")).map((e: { id: number }) => e.id)).toEqual([last.id]);
    expect((await search("", "&from=2026-02-01&to=2026-02-28&take=1&skip=1")).map((e: { id: number }) => e.id)).toEqual([first.id]);
    expect((await search("", "&from=2026-02-01&to=2026-02-28&event=BILL_POSTED&sourceType=TEST&sourceId=1")).map((e: { id: number }) => e.id)).toEqual([first.id]);
    expect((await search("", "&to=2026-01-31")).map((e: { id: number }) => e.id)).toEqual([before.id]);
    expect((await search("", "&from=2026-03-01")).map((e: { number: string }) => e.number)).toEqual(["JE-AFTER"]);
    expect(await search("Freight", "&event=PAYMENT_POSTED")).toEqual([]);
    expect(await search("Freight", "&sourceType=BILL")).toEqual([]);
    expect(await search("Freight", "&sourceId=999")).toEqual([]);
    expect(await search("missing")).toEqual([]);
  });

  it("rejects invalid calendar dates and reversed ranges", async () => {
    const { accountant } = await sampleCompany();
    for (const params of ["from=bad", "from=2026-02-30", "to=2026-02-30", "from=2026-03-01&to=2026-02-28"]) {
      expect((await accountant.get(`/api/journal?${params}`)).status, params).toBe(400);
    }
  });
});
