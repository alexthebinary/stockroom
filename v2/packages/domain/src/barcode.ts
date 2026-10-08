/**
 * Barcodes. A product's UPC-A, its EAN-13 and its GTIN-14 are the same number
 * padded differently, and a scanner may report any of them; GS1-128 and GS1
 * DataMatrix labels wrap the GTIN with lot, expiry and serial. Everything is
 * reduced to one lookup key so a scan finds the item however it was printed.
 */
export function isValidGtin(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export type Gs1 = { gtin?: string; lot?: string; expiry?: string; serial?: string };

const GS = "\u001d";
const FIXED: Record<string, { key: keyof Gs1; length: number }> = {
  "01": { key: "gtin", length: 14 },
  "17": { key: "expiry", length: 6 },
};
const VARIABLE: Record<string, keyof Gs1> = { "10": "lot", "21": "serial" };

/** Parses GS1 element strings, "(01)…(21)…" or raw with FNC1/GS separators. Null if it is not one. */
export function parseGs1(raw: string): Gs1 | null {
  let text = raw.trim().replace(/^\](C1|d2|Q3|e0)/, "");
  if (text.startsWith("(")) {
    const out: Gs1 = {};
    const re = /\((\d{2})\)([^(]+)/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = re.exec(text))) {
      const [all, ai, value] = match;
      const key = FIXED[ai!]?.key ?? VARIABLE[ai!];
      if (!key) return null;
      out[key] = value!;
      consumed += all.length;
    }
    return consumed === text.length && out.gtin ? out : null;
  }
  if (!text.startsWith("01") || text.length < 16) return null;
  const out: Gs1 = {};
  while (text.length > 0) {
    const ai = text.slice(0, 2);
    const fixed = FIXED[ai];
    if (fixed) {
      const value = text.slice(2, 2 + fixed.length);
      if (value.length !== fixed.length || !/^\d+$/.test(value)) return null;
      out[fixed.key] = value;
      text = text.slice(2 + fixed.length).replace(/^\u001d/, "");
      continue;
    }
    const variable = VARIABLE[ai];
    if (!variable) return null;
    const end = text.indexOf(GS);
    out[variable] = end === -1 ? text.slice(2) : text.slice(2, end);
    text = end === -1 ? "" : text.slice(end + 1);
  }
  return out.gtin && isValidGtin(out.gtin) ? out : null;
}

/** The key a scanned or typed code is stored and looked up by. */
export function barcodeKey(raw: string): string {
  const trimmed = raw.trim();
  const gs1 = parseGs1(trimmed);
  if (gs1?.gtin) return gs1.gtin;
  if (isValidGtin(trimmed)) return trimmed.padStart(14, "0");
  return trimmed.toUpperCase();
}
