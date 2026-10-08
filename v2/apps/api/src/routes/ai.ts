import { barcodeKey, DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { imageFromDataUrl } from "../ai/reader";
import type { Deps } from "../app";
import { lookupCode } from "../catalog";
import { parse } from "../http";

const imageBody = z.object({ image: z.string().startsWith("data:image/").max(12_000_000), vendorId: z.number().int().positive().nullish() });

export function registerAi(app: FastifyInstance, { db, reader }: Deps) {
  app.get("/api/ai/status", async () => ({ available: reader != null }));

  function imageOf(dataUrl: string) {
    const image = imageFromDataUrl(dataUrl);
    if (!image) throw new DomainError("Send a JPEG, PNG, WebP or GIF photo", 400);
    return image;
  }

  /**
   * Read a packing slip, then match what it says to OUR records: the vendor by
   * name, the PO by number, each line by barcode, the vendor's item number, or
   * our SKU. Everything comes back as a proposal for the clerk to confirm.
   */
  app.post("/api/ai/read-slip", async (request) => {
    if (!reader) return { available: false };
    const body = parse(imageBody, request.body);
    const result = await reader.readPackingSlip(imageOf(body.image));
    if (!result.ok) return { available: true, ok: false, reason: result.reason, message: result.message };
    const slip = result.data;
    const vendors = await db.vendor.findMany({ where: { isActive: true } });
    const name = slip.vendorName?.toLowerCase().trim();
    const vendor = body.vendorId
      ? (vendors.find((v) => v.id === body.vendorId) ?? null)
      : name
        ? (vendors.find((v) => v.name.toLowerCase() === name) ?? vendors.find((v) => name.includes(v.name.toLowerCase()) || v.name.toLowerCase().includes(name)) ?? null)
        : null;
    const poNumber = slip.poNumber?.toUpperCase().replace(/\s+/g, "");
    const po = poNumber
      ? await db.purchaseOrder.findFirst({ where: { lifecycle: "OPEN", OR: [{ number: poNumber }, { number: `PO-${poNumber.replace(/^PO-?/, "").padStart(5, "0")}` }] } })
      : null;
    const lines = [];
    for (const line of slip.lines) {
      const match =
        (line.barcode ? await lookupCode(db, line.barcode, vendor?.id) : null) ??
        (line.vendorSku ? await lookupCode(db, line.vendorSku, vendor?.id) : null);
      const item = match ? await db.item.findUnique({ where: { id: match.itemId } }) : null;
      lines.push({
        ...line,
        unitPriceCents: line.unitPrice == null ? null : Math.round(line.unitPrice * 100),
        itemId: item?.id ?? null,
        item,
        matchedBy: match?.via ?? null,
        normalizedBarcode: line.barcode ? barcodeKey(line.barcode) : null,
      });
    }
    return {
      available: true,
      ok: true,
      model: result.model,
      slip: { vendorName: slip.vendorName, poNumber: slip.poNumber, documentNumber: slip.documentNumber, documentDate: slip.documentDate, isInvoice: slip.isInvoice },
      vendor,
      po: po ? { id: po.id, number: po.number } : null,
      lines,
    };
  });

  /** Read a serial (and maybe a barcode) off a label: the fallback when a GS1 code isn't there to scan. */
  app.post("/api/ai/read-label", async (request) => {
    if (!reader) return { available: false };
    const body = parse(imageBody, request.body);
    const result = await reader.readLabel(imageOf(body.image));
    if (!result.ok) return { available: true, ok: false, reason: result.reason, message: result.message };
    const match = result.data.barcode ? await lookupCode(db, result.data.barcode, body.vendorId) : null;
    return { available: true, ok: true, model: result.model, label: result.data, match };
  });
}
