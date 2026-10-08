import { barcodeKey, parseGs1 } from "@pi/domain";
import type { Db, Tx } from "./db";

export type Match = { itemId: number; packQty: number; via: "BARCODE" | "VENDOR_SKU" | "SKU" };

/**
 * What did the clerk just scan? A barcode (normalised so UPC-A, EAN-13 and
 * GTIN-14 meet), then this vendor's own item number, then our SKU. A case
 * barcode brings its pack quantity, so one scan of a case of 12 counts 12.
 */
export async function lookupCode(tx: Tx | Db, raw: string, vendorId?: number | null): Promise<(Match & { serial?: string }) | null> {
  const key = barcodeKey(raw);
  const serial = parseGs1(raw)?.serial;
  const barcode = await tx.itemBarcode.findUnique({ where: { code: key }, include: { item: true } });
  if (barcode?.item.isActive) return { itemId: barcode.itemId, packQty: barcode.packQty, via: "BARCODE", serial };
  const text = raw.trim();
  if (vendorId) {
    const vendorItem = await tx.vendorItem.findFirst({ where: { vendorId, vendorSku: { equals: text, mode: "insensitive" } } });
    if (vendorItem) return { itemId: vendorItem.itemId, packQty: 1, via: "VENDOR_SKU" };
  }
  const item = await tx.item.findFirst({ where: { sku: { equals: text, mode: "insensitive" }, isActive: true } });
  if (item) return { itemId: item.id, packQty: 1, via: "SKU" };
  return null;
}

/** Teach the catalog a barcode (setup, or mapping an unknown scan). Refuses one already in use. */
export async function addBarcode(tx: Tx, itemId: number, raw: string, packQty = 1) {
  return tx.itemBarcode.create({ data: { itemId, raw: raw.trim(), code: barcodeKey(raw), packQty } });
}
