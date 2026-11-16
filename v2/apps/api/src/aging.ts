export const DAY = 86_400_000;

/** Whole days a due date is past `asOf`; zero or less means not yet late. */
export const daysLate = (due: Date | number, asOf: Date | number): number =>
  Math.floor((Number(asOf) - Number(due)) / DAY);

/**
 * Payable totals for the home screen. Uses the same lateness rule as the AP
 * aging report, so a bill is overdue here exactly when aging puts it past
 * "current". Due in 7 days excludes overdue bills: the two never overlap.
 */
export function payableTotals(open: { openCents: number; due: Date | number }[], now: Date | number = Date.now()) {
  const sum = (rows: typeof open) => rows.reduce((s, b) => s + b.openCents, 0);
  const overdue = open.filter((b) => daysLate(b.due, now) > 0);
  const upcoming = open.filter((b) => daysLate(b.due, now) <= 0 && Number(b.due) <= Number(now) + 7 * DAY);
  return { payableCents: sum(open), dueThisWeekCents: sum(upcoming), overdueCents: sum(overdue) };
}
