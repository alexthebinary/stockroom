import { describe, expect, it } from "vitest";
import { checkBooks } from "../src/books";
import { inTx } from "../src/db";
import { postEntry, reverseEntry } from "../src/ledger";
import { client, expectBooksSound, ok, resetDb, sampleCompany, testDb } from "./helpers";

describe("ledger", () => {
  it("refuses an unbalanced entry before it is written", async () => {
    const db = await resetDb();
    await expect(
      inTx(db, (tx) =>
        postEntry(tx, {
          event: "BILL_PAYMENT",
          date: new Date(),
          sourceType: "TEST",
          sourceId: 1,
          actor: "test",
          lines: [
            { role: "payable", amountCents: 100, vendorId: 1 },
            { role: "bank", amountCents: 99 },
          ],
        }),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it("has the database refuse an unbalanced entry even if code tried to write one", async () => {
    const db = await resetDb();
    const bank = await db.account.findUniqueOrThrow({ where: { code: "1000" } });
    await expect(
      db.journalEntry.create({
        data: { number: "JE-X", event: "TEST", date: new Date(), sourceType: "TEST", sourceId: 1, actor: "test", lines: { create: [{ accountId: bank.id, role: "bank", side: "DEBIT", amountCents: 5 }] } },
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it("reverses an entry once, and the reversal nets it to zero", async () => {
    const { ids } = await sampleCompany();
    const db = testDb();
    const entry = await inTx(db, (tx) =>
      postEntry(tx, {
        event: "BILL_PAYMENT",
        date: new Date(),
        sourceType: "TEST",
        sourceId: 1,
        actor: "test",
        lines: [
          { role: "payable", amountCents: 100, vendorId: ids.supplier },
          { role: "bank", amountCents: 100 },
        ],
      }),
    );
    await inTx(db, (tx) => reverseEntry(tx, entry!.id, "test"));
    const sums = await db.journalLine.groupBy({ by: ["accountId", "side"], _sum: { amountCents: true } });
    const net = sums.reduce((s, r) => s + (r.side === "DEBIT" ? 1 : -1) * (r._sum.amountCents ?? 0), 0);
    expect(net).toBe(0);
    await expect(inTx(db, (tx) => reverseEntry(tx, entry!.id, "test"))).rejects.toThrow(/already been reversed/);
  });

  it("lets an admin repoint an unlocked role, with history, and refuses the locked inventory roles", async () => {
    const { admin } = await sampleCompany();
    const operating = ok(await admin.post("/api/accounts", { code: "1010", name: "Operating account", type: "ASSET", normalSide: "DEBIT" })).body;
    ok(await admin.put("/api/posting-rules/bank", { accountId: operating.id }));
    const rules = ok(await admin.get("/api/posting-rules")).body as { role: string; account: { code: string }; changes: unknown[] }[];
    const bank = rules.find((r) => r.role === "bank")!;
    expect(bank.account.code).toBe("1010");
    expect(bank.changes).toHaveLength(1);
    const locked = await admin.put("/api/posting-rules/inventoryOnHand", { accountId: operating.id });
    expect(locked.status).toBe(409);
    const header = (await testDb().account.findUniqueOrThrow({ where: { code: "1200" } })).id;
    expect((await admin.put("/api/posting-rules/cogs", { accountId: header })).status).toBe(400);
  });
});

describe("the books-sound check", () => {
  it("passes on a sound company and catches a planted mismatch (it can fail)", async () => {
    const { admin, ids } = await sampleCompany();
    ok(await admin.post("/api/setup/opening-stock", { lines: [{ itemId: ids.widget, warehouseId: ids.warehouse, qty: 2, unitCostCents: 55000 }] }));
    await expectBooksSound();
    await testDb().costPool.update({ where: { itemId: ids.widget }, data: { valueCents: 109999 } });
    const report = await checkBooks(testDb());
    expect(report.sound).toBe(false);
    expect(report.problems.join("\n")).toMatch(/Inventory – On Hand is 110000 but its stock is valued at 109999/);
    await testDb().stockBalance.updateMany({ where: { itemId: ids.widget }, data: { onHand: 3 } });
    const second = await checkBooks(testDb());
    expect(second.problems.join("\n")).toMatch(/ON_HAND is 3 but the registers say 2/);
    expect(ok(await client().get("/api/books/check")).body.sound).toBe(false);
  });
});
