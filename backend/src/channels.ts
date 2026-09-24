/**
 * Sales channels, and the one fact about each that changes the books: WHEN the
 * customer pays.
 *
 * A consumer brand sells through channels that settle in opposite orders. A
 * Shopify or Amazon shopper pays at checkout, a showroom client pays at the counter, days before anything ships; a
 * wholesale buyer takes the goods first and pays on terms. Treating both as
 * "invoice, then get paid" either books revenue for goods still on the shelf
 * or leaves checkout cash with nothing to explain it. So the channel carries
 * its payment policy, and the order flow reads it rather than guessing.
 *
 * Revenue is recognised when goods SHIP, whatever the channel: that is when
 * control passes to the customer (ASC 606 / IFRS 15, shipping-point terms).
 * Checkout money waits in Customer Deposits until then.
 */
export type ChannelPolicy = {
  code: string;
  label: string;
  /** PREPAID: paid at checkout. TERMS: invoiced on shipment, paid later. */
  payment: "PREPAID" | "TERMS";
  /** Days from invoice to due date. 0 for prepaid channels. */
  termsDays: number;
  /**
   * Default sales tax on this channel's orders, in percent. Pennsylvania's
   * rate is 6% (pa.gov, Sales, Use and Hotel Occupancy Tax, read 2026-09-24);
   * Allegheny County adds 1% and Philadelphia 2% for sales delivered there
   * (Act 21 of 2026) — the order form lets a clerk change it for those.
   * Amazon 0: it collects and remits as the marketplace facilitator
   * (UNVERIFIED against pa.gov — confirm before the first PA return).
   * Wholesale 0: buyers purchase for resale on an exemption certificate.
   */
  defaultTaxPct: number;
};

export const CHANNELS: ChannelPolicy[] = [
  { code: "SHOPIFY", label: "Shopify store", payment: "PREPAID", termsDays: 0, defaultTaxPct: 6 },
  { code: "AMAZON", label: "Amazon", payment: "PREPAID", termsDays: 0, defaultTaxPct: 0 },
  /// A client in the showroom: pays at the counter and leaves with the goods.
  { code: "SHOWROOM", label: "Showroom / in store", payment: "PREPAID", termsDays: 0, defaultTaxPct: 6 },
  { code: "WHOLESALE", label: "Wholesale (net 30)", payment: "TERMS", termsDays: 30, defaultTaxPct: 0 },
  { code: "DIRECT", label: "Direct / phone order", payment: "TERMS", termsDays: 30, defaultTaxPct: 6 },
];

export const CHANNEL_CODES = CHANNELS.map((c) => c.code) as [string, ...string[]];

/** Unknown codes (older data) are treated as DIRECT rather than refused. */
export function channelPolicy(code: string | null | undefined): ChannelPolicy {
  return CHANNELS.find((c) => c.code === code) ?? CHANNELS.find((c) => c.code === "DIRECT")!;
}

export function dueDateFor(code: string | null | undefined, issued: Date): Date {
  return new Date(issued.getTime() + channelPolicy(code).termsDays * 86_400_000);
}
