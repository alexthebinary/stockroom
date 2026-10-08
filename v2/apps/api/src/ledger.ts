import { type AmountLine, CHART, DEFAULT_ROLE_ACCOUNTS, DomainError, type EventType, planEntry, ROLES, type Role } from "@pi/domain";
import type { Db, Tx } from "./db";
import { nextNumber } from "./numbering";

/**
 * Boot: make sure every account in the GAAP chart and every posting role
 * exists. Never overwrites: an admin's rename or repoint survives restarts.
 */
export async function syncChart(db: Db) {
  for (const account of CHART) {
    await db.account.upsert({
      where: { code: account.code },
      create: {
        code: account.code,
        name: account.name,
        type: account.type,
        normalSide: account.normalSide,
        isHeader: account.header ?? false,
        purpose: account.purpose,
      },
      update: {},
    });
  }
  const byCode = new Map((await db.account.findMany()).map((a) => [a.code, a]));
  for (const account of CHART) {
    if (!account.parent) continue;
    const row = byCode.get(account.code)!;
    if (row.parentId == null) await db.account.update({ where: { id: row.id }, data: { parentId: byCode.get(account.parent)!.id } });
  }
  for (const [role, code] of Object.entries(DEFAULT_ROLE_ACCOUNTS)) {
    await db.postingRule.upsert({ where: { role }, create: { role, accountId: byCode.get(code)!.id }, update: {} });
  }
}

export type PostInput = {
  event: EventType;
  date: Date;
  sourceType: string;
  sourceId: number;
  actor: string;
  memo?: string;
  lines: AmountLine[];
};

/**
 * The one way money moves. Plans the lines (balanced, dimensions present),
 * resolves each role to the account an admin pointed it at, and writes the
 * entry. A zero entry (nothing to post) returns null rather than an empty row.
 */
export async function postEntry(tx: Tx, input: PostInput) {
  if (input.lines.every((l) => l.amountCents === 0)) return null;
  const planned = planEntry(input.event, input.lines);
  const rules = await tx.postingRule.findMany({ include: { account: true } });
  const accountFor = new Map(rules.map((r) => [r.role, r.account]));
  const number = await nextNumber(tx, "JE");
  return tx.journalEntry.create({
    data: {
      number,
      event: input.event,
      date: input.date,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      actor: input.actor,
      memo: input.memo,
      lines: {
        create: planned.map((line) => {
          const account = accountFor.get(line.role);
          if (!account || !account.isActive || account.isHeader) {
            throw new DomainError(`The ${line.role} role points at no usable account. Fix it under Settings → Account assignment.`, 409);
          }
          return {
            accountId: account.id,
            role: line.role,
            side: line.side,
            amountCents: line.amountCents,
            itemId: line.itemId,
            vendorId: line.vendorId,
            poLineId: line.poLineId,
            memo: line.memo,
          };
        }),
      },
    },
    include: { lines: true },
  });
}

/** Undo by mirror image. The original stays; an entry can be reversed once. */
export async function reverseEntry(tx: Tx, entryId: number, actor: string, date = new Date()) {
  const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: true, reversedBy: true } });
  if (original.reversedBy) throw new DomainError(`${original.number} has already been reversed`, 409);
  const number = await nextNumber(tx, "JE");
  return tx.journalEntry.create({
    data: {
      number,
      event: `${original.event}_REVERSAL`,
      date,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      actor,
      memo: `Reverses ${original.number}`,
      reversesId: original.id,
      lines: {
        create: original.lines.map((l) => ({
          accountId: l.accountId,
          role: l.role,
          side: l.side === "DEBIT" ? "CREDIT" : "DEBIT",
          amountCents: l.amountCents,
          itemId: l.itemId,
          vendorId: l.vendorId,
          poLineId: l.poLineId,
          memo: l.memo,
        })),
      },
    },
  });
}

/** Admin repoints a role. Locked roles (the inventory accounts) refuse. */
export async function repointRole(tx: Tx, role: string, accountId: number, actor: string) {
  const definition = ROLES[role as Role];
  if (!definition) throw new DomainError(`There is no posting role called ${role}`, 404);
  if (definition.locked) {
    throw new DomainError(`${definition.label} is locked: the books-sound check compares it to the stock records`, 409);
  }
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (!account || !account.isActive || account.isHeader) throw new DomainError("Pick an active posting account (not a header)", 400);
  const rule = await tx.postingRule.findUniqueOrThrow({ where: { role } });
  if (rule.accountId === accountId) return rule;
  await tx.postingRuleChange.create({ data: { ruleId: rule.id, fromAccountId: rule.accountId, toAccountId: accountId, actor } });
  return tx.postingRule.update({ where: { id: rule.id }, data: { accountId } });
}
