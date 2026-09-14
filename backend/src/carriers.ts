/**
 * Carrier tracking links.
 *
 * A static map, deliberately. Stockroom records which carrier took a parcel and
 * the number the customer quotes; it does not call carrier APIs, buy labels,
 * validate addresses or shop rates. Those make a shipping platform, which is a
 * different product with different failure modes — a WMS that cannot ship
 * because UPS is down is a worse WMS.
 *
 * So this turns a number the operator typed into a link the operator can click,
 * with no network call and nothing to break. North American carriers, matching
 * the target market.
 */
const TRACKING_URLS: Record<string, string> = {
  UPS: "https://www.ups.com/track?tracknum=",
  FEDEX: "https://www.fedex.com/fedextrack/?trknbr=",
  USPS: "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
  DHL: "https://www.dhl.com/us-en/home/tracking.html?tracking-id=",
  CANADA_POST: "https://www.canadapost-postescanada.ca/track-reperage/en#/details/",
  PUROLATOR: "https://www.purolator.com/en/shipping/tracker?pin=",
};

/** The carriers the UI offers. Free text is still accepted for anything else. */
export const CARRIERS = Object.keys(TRACKING_URLS);

export function trackingUrl(carrier?: string | null, trackingNumber?: string | null) {
  if (!carrier || !trackingNumber) return null;
  const base = TRACKING_URLS[carrier.trim().toUpperCase().replace(/[\s-]+/g, "_")];
  return base ? base + encodeURIComponent(trackingNumber.trim()) : null;
}
