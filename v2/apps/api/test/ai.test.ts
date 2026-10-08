import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createClaudeReader, imageFromDataUrl, MODEL, type PackingSlip, type ParseClient, type Reader } from "../src/ai/reader";
import { client, ok, sampleCompany } from "./helpers";

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
const image = imageFromDataUrl(PIXEL)!;

function stubClient(respond: () => unknown) {
  const parse = vi.fn(async (_params: unknown) => respond());
  return { client: { beta: { messages: { parse } } } as unknown as ParseClient, parse };
}

describe("the Claude reader", () => {
  it("asks for structured output from the image, with server-side fallbacks on", async () => {
    const slip: PackingSlip = { vendorName: "Acme", poNumber: null, documentNumber: "PS-1", documentDate: null, isInvoice: false, lines: [] };
    const { client: c, parse } = stubClient(() => ({ stop_reason: "end_turn", parsed_output: slip, model: MODEL }));
    const result = await createClaudeReader(c).readPackingSlip(image);
    expect(result).toEqual({ ok: true, data: slip, model: MODEL });
    const params = (parse.mock.calls as unknown as Record<string, any>[][])[0]![0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.betas).toContain("server-side-fallback-2026-07-01");
    expect(params.fallbacks).toBe("default");
    expect(params.output_config.format).toBeDefined();
    expect(params.thinking, "thinking is left at its default; effort controls depth").toBeUndefined();
    expect(params.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: image.base64 } });
  });

  it("degrades to manual entry on a refusal, an unparseable answer, or an outage — never throws", async () => {
    const refused = await createClaudeReader(stubClient(() => ({ stop_reason: "refusal", parsed_output: null })).client).readLabel(image);
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    const unreadable = await createClaudeReader(stubClient(() => ({ stop_reason: "end_turn", parsed_output: null })).client).readLabel(image);
    expect(unreadable).toMatchObject({ ok: false, reason: "unreadable" });
    const down = await createClaudeReader(
      stubClient(() => {
        throw new Anthropic.APIConnectionError({ message: "offline" });
      }).client,
    ).readLabel(image);
    expect(down).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("accepts only image data URLs", () => {
    expect(imageFromDataUrl("data:application/pdf;base64,AAAA")).toBeNull();
    expect(imageFromDataUrl("https://example.com/a.png")).toBeNull();
  });
});

describe("reading a packing slip at the dock", () => {
  const fake = (slip: PackingSlip): Reader => ({
    readPackingSlip: async () => ({ ok: true, data: slip, model: MODEL }),
    readLabel: async () => ({ ok: true, data: { serial: "SN-0042", barcode: "012345678912", productName: null, modelNumber: null, confident: true }, model: MODEL }),
  });

  it("matches the vendor, the PO and each line to our records, as a proposal", async () => {
    const c = await sampleCompany();
    const po = ok(await c.admin.post("/api/purchase-orders", { vendorId: c.ids.supplier, warehouseId: c.ids.warehouse, lines: [{ itemId: c.ids.widget, qtyOrdered: 2, unitCostCents: 50000 }] })).body;
    const reader = fake({
      vendorName: "SAMPLE SUPPLIER CO. INC",
      poNumber: po.number.replace("PO-", ""),
      documentNumber: "PS-778",
      documentDate: "2026-10-08",
      isInvoice: false,
      lines: [
        { vendorSku: null, barcode: "0012345678905", description: "Widget", quantity: 2, unitPrice: 499.5, serials: [], confident: true },
        { vendorSku: "SS-200", barcode: null, description: "Robot", quantity: 1, unitPrice: null, serials: ["SN-0001"], confident: true },
        { vendorSku: "ZZ-9", barcode: null, description: "Mystery", quantity: 1, unitPrice: null, serials: [], confident: false },
      ],
    });
    const clerk = client(c.profiles.clerk.id, reader);
    const read = ok(await clerk.post("/api/ai/read-slip", { image: PIXEL })).body;
    expect(read.vendor.id).toBe(c.ids.supplier);
    expect(read.po).toEqual({ id: po.id, number: po.number });
    expect(read.lines.map((l: { itemId: number | null; matchedBy: string | null; unitPriceCents: number | null }) => [l.itemId, l.matchedBy, l.unitPriceCents])).toEqual([
      [c.ids.widget, "BARCODE", 49950],
      [c.ids.robot, "VENDOR_SKU", null],
      [null, null, null],
    ]);
    const label = ok(await clerk.post("/api/ai/read-label", { image: PIXEL })).body;
    expect(label.label.serial).toBe("SN-0042");
    expect(label.match.itemId).toBe(c.ids.robot);
  });

  it("says so when no reader is configured, and refuses a non-image", async () => {
    const c = await sampleCompany();
    expect(ok(await c.clerk.get("/api/ai/status")).body).toEqual({ available: false });
    expect(ok(await c.clerk.post("/api/ai/read-slip", { image: PIXEL })).body).toEqual({ available: false });
    const withReader = client(c.profiles.clerk.id, fake({ vendorName: null, poNumber: null, documentNumber: null, documentDate: null, isInvoice: false, lines: [] }));
    expect((await withReader.post("/api/ai/read-slip", { image: "data:image/png;base64,***" })).status).toBe(400);
  });
});
