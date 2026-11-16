import { describe, expect, it } from "vitest";
import { DAY, daysLate, payableTotals } from "../src/aging";

describe("payable totals on the home screen", () => {
  const now = Date.UTC(2026, 10, 16, 15, 0, 0);
  const midnight = Date.UTC(2026, 10, 16);
  const bills = [
    { openCents: 100, due: midnight - 3 * DAY }, // overdue
    { openCents: 20, due: midnight }, // due today: not overdue, same as aging "current"
    { openCents: 3, due: midnight + 5 * DAY }, // due this week
    { openCents: 4000, due: midnight + 30 * DAY }, // later
  ];

  it("counts a bill due today as due this week, not overdue", () => {
    expect(daysLate(midnight, now)).toBe(0);
    expect(payableTotals(bills, now)).toEqual({ payableCents: 4123, dueThisWeekCents: 23, overdueCents: 100 });
  });

  it("never counts an overdue bill as due this week", () => {
    expect(payableTotals([bills[0]!], now)).toEqual({ payableCents: 100, dueThisWeekCents: 0, overdueCents: 100 });
  });

  it("turns overdue one full day after the due date", () => {
    expect(payableTotals([bills[1]!], midnight + DAY).overdueCents).toBe(20);
  });
});
