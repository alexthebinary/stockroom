import { conflict } from "./errors";
import type { Tx } from "./inventory";
import { prisma } from "./db";

/**
 * The accounting period lock.
 *
 * Without one, any entry of any date can be posted, unposted, reversed or
 * deleted at any time — including into a month somebody has already reported
 * on. Nothing tells them it changed. This is the control that makes a reported
 * period mean something.
 *
 * A reversal of a locked entry is still allowed, because refusing it would
 * leave a mistake permanently on the books with no way to correct it. The
 * reversal posts in the CURRENT period instead, which is standard practice and
 * the reason a lock does not trap you.
 */
export const LOCK_DATE_KEY = "ledger.lockDate";

/**
 * The lock is stored as a date and applied through the END of that day.
 *
 * "Closed to 30 September" means the whole of 30 September is shut, not that
 * the books reopened at one minute past midnight on it. Storing midnight and
 * comparing against it let an entry posted later the same day straight through
 * — caught by the first test written against this.
 */
function endOfDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export async function getLockDate(db: Tx | typeof prisma = prisma): Promise<Date | null> {
  const row = await db.ledgerSetting.findUnique({ where: { key: LOCK_DATE_KEY } });
  if (!row?.value) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : endOfDay(d);
}

export async function setLockDate(value: string | null) {
  if (value === null) {
    await prisma.ledgerSetting.deleteMany({ where: { key: LOCK_DATE_KEY } });
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw conflict("That is not a date the lock can use");
  await prisma.ledgerSetting.upsert({
    where: { key: LOCK_DATE_KEY },
    create: { key: LOCK_DATE_KEY, value: d.toISOString() },
    update: { value: d.toISOString() },
  });
  return d;
}

/** Refuse to touch a period that has been closed. */
export async function assertPeriodOpen(tx: Tx, entryDate: Date, what: string) {
  const lock = await getLockDate(tx);
  if (lock && entryDate.getTime() <= lock.getTime()) {
    throw conflict(
      `${what}: the books are closed to ${lock.toISOString().slice(0, 10)}. ` +
        `Post a correcting entry in the open period instead, or move the lock date.`
    );
  }
}
