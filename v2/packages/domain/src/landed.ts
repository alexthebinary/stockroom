import { refuse } from "./errors";
import { allocate, assertCents, type Cents } from "./money";

/**
 * Inbound landed cost, GAAP guide §I.4: freight is not an expense when goods
 * arrive; it is part of what the goods cost. It is spread over the bill's
 * lines by weighted average — by line value by default (a $900 printer carries
 * more freight than a $9 spool), or by quantity when the people who know the
 * shipment say so.
 */
export type AllocationBasis = "VALUE" | "QTY";

export type LandedLineInput = {
  key: string;
  qty: number;
  unitCostCents: Cents;
  /** A price discount on this one line (guide §II.1 #8: an item must be selected). */
  discountCents?: Cents;
};

export type LandedLine = LandedLineInput & {
  goodsCents: Cents;
  freightCents: Cents;
  landedCents: Cents;
  /** For display only. Receipts post exact slices of `landedCents`; see `receiptValue`. */
  landedUnitCents: number;
};

export function landedCost(lines: LandedLineInput[], freightCents: Cents, basis: AllocationBasis): LandedLine[] {
  assertCents(freightCents, "freight");
  const goods = lines.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw refuse(`line ${line.key}: quantity must be a positive whole number`);
    assertCents(line.unitCostCents, `line ${line.key} unit cost`);
    const discount = line.discountCents ?? 0;
    assertCents(discount, `line ${line.key} discount`);
    const gross = line.qty * line.unitCostCents;
    if (discount < 0 || discount > gross) throw refuse(`line ${line.key}: the discount must be between $0 and the line total`);
    return gross - discount;
  });
  const totalGoods = goods.reduce((a, b) => a + b, 0);
  const weights = basis === "VALUE" && totalGoods > 0 ? goods : lines.map((l) => l.qty);
  const freight = lines.length === 0 ? [] : allocate(freightCents, weights);
  return lines.map((line, i) => {
    const landedCents = goods[i]! + freight[i]!;
    return { ...line, goodsCents: goods[i]!, freightCents: freight[i]!, landedCents, landedUnitCents: landedCents / line.qty };
  });
}

/**
 * How much of a line's landed cost has cleared once `received` of `qty` units
 * have arrived. Exact at the end by construction, so however a delivery is
 * split — one box at a time included — the slices add up to the line.
 */
export function clearedAt(landedCents: Cents, qty: number, received: number): Cents {
  if (received >= qty) return landedCents;
  if (received <= 0) return 0;
  return Math.round((landedCents * received) / qty);
}

/** The value of `arriving` units when `before` have already been received. */
export function receiptValue(landedCents: Cents, qty: number, before: number, arriving: number): Cents {
  return clearedAt(landedCents, qty, before + arriving) - clearedAt(landedCents, qty, before);
}

export type LineProgress = {
  /** Units on the bill line. */
  lineQty: number;
  /** Units of it that have physically arrived and posted. */
  receivedQty: number;
  /** Units of those still in stock (the rest were sold or issued). */
  onHandQty: number;
};

/**
 * An amount that lands on a bill line after the fact (a carrier's freight-in
 * bill, a vendor's price discount). The share for units not yet received
 * raises or lowers what they will cost when they arrive (Inbound); the share
 * for units still on hand revalues the pool (On Hand); the share for units
 * already sold has nowhere to go but Cost of Goods Sold.
 */
export function splitAdjustment(amountCents: Cents, progress: LineProgress): { inbound: Cents; onHand: Cents; sold: Cents } {
  const { lineQty, receivedQty, onHandQty } = progress;
  if (lineQty <= 0 || receivedQty < 0 || receivedQty > lineQty || onHandQty < 0 || onHandQty > receivedQty) {
    throw refuse(`impossible line progress: ${JSON.stringify(progress)}`);
  }
  const [inbound, onHand, sold] = allocate(amountCents, [lineQty - receivedQty, onHandQty, receivedQty - onHandQty]);
  return { inbound: inbound!, onHand: onHand!, sold: sold! };
}
