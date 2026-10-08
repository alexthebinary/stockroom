import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * Claude reads what a barcode can't: a packing slip, a label with a printed
 * serial. Its answer is only ever a PROPOSAL — matched to the catalog by our
 * own code and confirmed by the clerk line by line. It never creates items,
 * never posts anything, and when it can't help (no key, a refusal, an
 * unreadable photo, an outage) the clerk carries on by hand.
 */

export const MODEL = "claude-opus-5-5";

export const PackingSlip = z.object({
  vendorName: z.string().nullable().describe("The company that shipped the goods, as printed. Null if not shown."),
  poNumber: z.string().nullable().describe("The buyer's purchase order number if printed (often 'PO', 'Your order', 'Customer PO'). Null if not shown."),
  documentNumber: z.string().nullable().describe("The slip's own number: packing slip, delivery note or invoice number."),
  documentDate: z.string().nullable().describe("The document date as YYYY-MM-DD, or null."),
  isInvoice: z.boolean().describe("True if this is an invoice (it states amounts due), false for a packing slip / delivery note."),
  lines: z.array(
    z.object({
      vendorSku: z.string().nullable().describe("The vendor's item number / SKU / part number for the line."),
      barcode: z.string().nullable().describe("A UPC/EAN/GTIN printed on the line, digits only."),
      description: z.string().describe("The line's description as printed."),
      quantity: z.number().int().describe("Quantity shipped on this line (not ordered or back-ordered)."),
      unitPrice: z.number().nullable().describe("Unit price in US dollars if printed, else null."),
      serials: z.array(z.string()).describe("Serial numbers listed for this line, if any."),
      confident: z.boolean().describe("False if any part of this line was hard to read."),
    }),
  ),
});
export type PackingSlip = z.infer<typeof PackingSlip>;

export const Label = z.object({
  serial: z.string().nullable().describe("The unit's serial number (S/N, SN, Serial No.). Null if none is printed."),
  barcode: z.string().nullable().describe("A product barcode number (UPC/EAN/GTIN) printed under a barcode, digits only."),
  productName: z.string().nullable(),
  modelNumber: z.string().nullable(),
  confident: z.boolean().describe("False if the serial was partly obscured or ambiguous (0/O, 1/I/l, 5/S, 8/B)."),
});
export type Label = z.infer<typeof Label>;

export type ReadResult<T> = { ok: true; data: T; model: string } | { ok: false; reason: "refused" | "unreadable" | "unavailable"; message: string };

export type Reader = {
  readPackingSlip(image: ImageInput): Promise<ReadResult<PackingSlip>>;
  readLabel(image: ImageInput): Promise<ReadResult<Label>>;
};

export type ImageInput = { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; base64: string };

/** "data:image/jpeg;base64,…" → the parts the API wants, or null. */
export function imageFromDataUrl(dataUrl: string): ImageInput | null {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match ? { mediaType: match[1] as ImageInput["mediaType"], base64: match[2]! } : null;
}

const SLIP_INSTRUCTIONS = `You are reading a photo of a document that arrived with a delivery at a warehouse dock: usually a packing slip or delivery note, sometimes the vendor's invoice.
Extract exactly what is printed. Do not guess or invent values: if something is not shown or you cannot read it, use null (or an empty list).
Quantities are what was SHIPPED in this delivery, not what was ordered or back-ordered.
Prices are in US dollars as plain numbers.
A warehouse clerk will check every line you return against the boxes in front of them.`;

const LABEL_INSTRUCTIONS = `You are reading a photo of a product label or carton at a warehouse dock.
Find the unit's serial number and any product barcode number printed as digits. Copy characters exactly; do not correct or complete them.
If the serial is partly hidden or a character is ambiguous (0/O, 1/I/l, 5/S, 8/B), still give your best reading but set confident to false.
Use null for anything not shown.`;

/** The slice of the SDK the reader uses, so tests can stand in for it. */
export type ParseClient = { beta: { messages: { parse: Anthropic["beta"]["messages"]["parse"] } } };

export function createClaudeReader(client: ParseClient): Reader {
  async function read<T>(schema: z.ZodType<T>, instructions: string, image: ImageInput, prompt: string): Promise<ReadResult<T>> {
    try {
      const response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
        system: instructions,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
              { type: "text", text: prompt },
            ],
          },
        ],
      });
      if (response.stop_reason === "refusal") return { ok: false, reason: "refused", message: "The reader declined this photo. Enter it by hand." };
      if (response.parsed_output == null) return { ok: false, reason: "unreadable", message: "Couldn't make sense of that photo. Try again closer, or enter it by hand." };
      return { ok: true, data: response.parsed_output as T, model: response.model };
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) return { ok: false, reason: "unavailable", message: "The reader is busy. Try again in a minute, or enter it by hand." };
      if (error instanceof Anthropic.APIError) return { ok: false, reason: "unavailable", message: `The reader is unavailable (${error.status ?? "network"}). Enter it by hand.` };
      return { ok: false, reason: "unavailable", message: "The reader is unavailable. Enter it by hand." };
    }
  }
  return {
    readPackingSlip: (image) => read(PackingSlip, SLIP_INSTRUCTIONS, image, "Read this delivery document."),
    readLabel: (image) => read(Label, LABEL_INSTRUCTIONS, image, "Read this label."),
  };
}

/** Configured from ANTHROPIC_API_KEY. Without it, there is no reader and the app hides it. */
export function createReader(): Reader | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return createClaudeReader(new Anthropic({ timeout: 60_000, maxRetries: 2 }));
}
