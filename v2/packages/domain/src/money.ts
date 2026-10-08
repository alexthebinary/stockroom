import { refuse } from "./errors";

/** Every amount in the system is an integer number of US cents. */
export type Cents = number;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isInteger(value)) throw refuse(`${label} must be in whole cents, got ${value}`);
  return value;
}

const negate = (n: number) => (n === 0 ? 0 : -n);

/**
 * Split `total` across `weights` so the parts add back to exactly `total`.
 *
 * Largest-remainder: every part gets the floor of its exact share, then the
 * cents left over go one each to the parts with the biggest fractional
 * remainders (ties to the earlier part, so the result is deterministic).
 * A negative total, such as a discount, is split by the same shape.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  assertCents(total, "the total");
  if (weights.some((w) => w < 0)) throw refuse("allocation weights cannot be negative");
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return weights.map(() => 0);
  if (weights.length === 0 || weightSum <= 0) throw refuse("allocation weights must include something to carry the amount");
  if (total < 0) return allocate(-total, weights).map(negate);

  const exact = weights.map((w) => (total * w) / weightSum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((e, index) => ({ index, remainder: e - Math.floor(e) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    parts[index]! += 1;
    left -= 1;
  }
  return parts;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(cents: Cents): string {
  return usd.format(cents / 100);
}

/** "1,100.00", "$550", "0.5" → cents. Anything else, or sub-cent precision, → null. */
export function parseUsd(text: string): Cents | null {
  const cleaned = text.trim().replace(/[$,\s]/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? negate(cents) : cents;
}
