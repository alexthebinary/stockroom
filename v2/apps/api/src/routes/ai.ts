import { barcodeKey, DomainError, State } from "@pi/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { judge, readTypesafeKey, type JudgeDb, type JudgeResult } from "../ai/judge";
import { imageFromDataUrl } from "../ai/reader";
import type { Deps } from "../app";
import { lookupCode } from "../catalog";
import { Prisma, type Db } from "../db";
import { actorOf, idParam, parse } from "../http";
import { createHelpRateLimit } from "./help";

const imageBody = z.object({ image: z.string().startsWith("data:image/").max(12_000_000), vendorId: z.number().int().positive().nullish() });

export function registerAi(app: FastifyInstance, deps: Deps) {
  const { db, reader, clarifier } = deps;
  const hit = createHelpRateLimit(20);
  let active = 0;
  async function limited<T>(request: FastifyRequest, reply: FastifyReply, work: () => Promise<T>): Promise<T> {
    if (hit(request.ip)) {
      reply.header("Retry-After", "600");
      throw Object.assign(new Error("A lot of photos came from this device. Try again in a few minutes."), { statusCode: 429 });
    }
    if (active >= 2) {
      reply.header("Retry-After", "5");
      throw Object.assign(new Error("The photo reader is busy. Try again in a few seconds."), { statusCode: 429 });
    }
    active++;
    try { return await work(); }
    finally { active--; }
  }

  app.get("/api/ai/status", async () => ({ available: reader != null, clarify: clarifier != null }));

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
  app.post("/api/ai/read-slip", async (request, reply) => {
    if (!reader) return { available: false };
    const body = parse(imageBody, request.body);
    const result = await limited(request, reply, () => reader.readPackingSlip(imageOf(body.image)));
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
      ? await db.purchaseOrder.findFirst({ where: { lifecycle: State.poLifecycle.OPEN, OR: [{ number: poNumber }, { number: `PO-${poNumber.replace(/^PO-?/, "").padStart(5, "0")}` }] } })
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
  app.post("/api/ai/read-label", async (request, reply) => {
    if (!reader) return { available: false };
    const body = parse(imageBody, request.body);
    const result = await limited(request, reply, () => reader.readLabel(imageOf(body.image)));
    if (!result.ok) return { available: true, ok: false, reason: result.reason, message: result.message };
    const match = result.data.barcode ? await lookupCode(db, result.data.barcode, body.vendorId) : null;
    return { available: true, ok: true, model: result.model, label: result.data, match };
  });

  registerJudgments(app, deps);
}

const CANDIDATE_CAP = 8;
const NONE = "none";
const itemFields = { id: true, name: true, sku: true, brand: true, isActive: true, trackingMode: true, isBundle: true } as const;
type CatalogItem = { id: number; name: string; sku: string; brand: string | null; isActive: boolean; trackingMode: string; isBundle: boolean };
type Candidate = { itemId: number; name: string; sku: string; brand: string | null; reason: string };

/** One tap receives without serials, so serial-tracked items and bundles stay on the manual path. */
function eligible(item: CatalogItem): boolean {
  return item.isActive && item.trackingMode === "NONE" && !item.isBundle;
}

/**
 * Outstanding lines on this delivery's purchase order, then items this vendor
 * has ordered before, eight at most. Same identity as resolveUnknown: a code
 * matches on its own; a code-less row also matches its name.
 */
async function unknownCandidates(db: Db, session: { vendorId: number | null; poId: number | null }, unknown: { code: string | null; name: string | null }): Promise<{ candidates: Candidate[]; poNumber: string | null }> {
  const text = `${unknown.name ?? ""} ${unknown.code ?? ""}`.toLowerCase();
  const chosen: Candidate[] = [];
  const seen = new Set<number>();
  let poNumber: string | null = null;

  const add = (item: CatalogItem, reason: string) => {
    if (chosen.length >= CANDIDATE_CAP || seen.has(item.id)) return;
    seen.add(item.id);
    if (!eligible(item)) return;
    chosen.push({ itemId: item.id, name: item.name, sku: item.sku, brand: item.brand, reason });
  };

  if (session.poId) {
    const po = await db.purchaseOrder.findUnique({ where: { id: session.poId }, include: { lines: { orderBy: { id: "asc" } } } });
    if (po) {
      poNumber = po.number;
      const ids = po.lines.filter((line) => line.qtyOrdered > line.qtyReceived).map((line) => line.itemId);
      const items = await db.item.findMany({ where: { id: { in: ids } }, select: itemFields });
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const id of ids) {
        const item = byId.get(id);
        if (item) add(item, `On order ${po.number}`);
      }
    }
  }

  if (session.vendorId && chosen.length < CANDIDATE_CAP) {
    const orders = await db.purchaseOrder.findMany({
      where: { vendorId: session.vendorId },
      include: { lines: { orderBy: { id: "desc" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const ids: number[] = [];
    for (const order of orders) {
      for (const line of order.lines) {
        if (!seen.has(line.itemId) && !ids.includes(line.itemId)) ids.push(line.itemId);
      }
    }
    const items = await db.item.findMany({ where: { id: { in: ids } }, select: itemFields });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const id of ids) {
      if (chosen.length >= CANDIDATE_CAP) break;
      const item = byId.get(id);
      if (!item) continue;
      const brand = item.brand?.trim();
      const sameBrand = !!brand && brand.length >= 2 && text.includes(brand.toLowerCase());
      add(item, sameBrand ? "Same brand" : "Bought from this vendor before");
    }
  }
  return { candidates: chosen, poNumber };
}

function sameUnknown(row: { code: string | null; name: string | null }, input: { code: string | null; name: string | null }) {
  return row.code === input.code && (input.code != null || row.name === input.name);
}

function topThree(candidates: Candidate[], judged: JudgeResult) {
  const byId = new Map(candidates.map((candidate) => [String(candidate.itemId), candidate]));
  const ranked = Object.entries(judged.probabilities)
    .filter(([id]) => id !== NONE && byId.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const choiceFirst = byId.has(judged.choice) ? [judged.choice, ...ranked.filter((id) => id !== judged.choice)] : ranked;
  return choiceFirst.slice(0, 3).map((id) => byId.get(id)!);
}

function judgeDb(db: Db): JudgeDb {
  return { aiJudgment: { create: (args) => db.aiJudgment.create({ data: args.data }) } };
}

function registerJudgments(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  app.get("/api/ai/unknown-suggestions", async (request) => {
    const query = parse(
      z.object({
        sessionId: z.coerce.number().int().positive(),
        code: z.string().optional().transform((value) => (value ? value : null)),
        name: z.string().optional().transform((value) => (value ? value : null)),
      }),
      request.query,
    );
    const session = await db.scanSession.findUnique({ where: { id: query.sessionId } });
    const summary = session?.result as { unknown?: { code: string | null; name: string | null; qty: number }[] } | null;
    const unknown = session?.status === State.scanSession.SUBMITTED ? summary?.unknown?.find((row) => sameUnknown(row, query)) : undefined;
    if (!session || !unknown) throw new DomainError("That unknown item was not found", 404);
    const { candidates, poNumber } = await unknownCandidates(db, session, unknown);
    if (candidates.length === 0) return { judgmentId: null, suggestions: [] };
    const vendor = session.vendorId ? await db.vendor.findUnique({ where: { id: session.vendorId }, select: { name: true } }) : null;
    const criteria: Record<string, string> = {};
    for (const candidate of candidates) criteria[String(candidate.itemId)] = [candidate.name, candidate.sku, candidate.brand].filter(Boolean).join(", ");
    criteria[NONE] = "None of these catalog items is the scanned box.";
    const apiKey = deps.typesafeApiKey !== undefined ? deps.typesafeApiKey : readTypesafeKey();
    const judged = await judge(
      {
        key: "unknown_item_match",
        subject: `scan:${session.id}`,
        state: { scanned_code: unknown.code, description: unknown.name, quantity: unknown.qty, vendor: vendor?.name ?? null, purchase_order: poNumber },
        instructions: "Which catalog item is this unknown scanned box? The scanned code may be a barcode or a vendor item number. Pick none when none of the candidates is that box.",
        criteria,
        actor: actorOf(request),
      },
      { fetch: deps.judgeFetch ?? fetch, apiKey, db: judgeDb(db) },
    );
    if (!judged || judged.band === "NONE" || judged.choice === NONE) return { judgmentId: null, suggestions: [] };
    return {
      judgmentId: judged.id,
      suggestions: topThree(candidates, judged).map((candidate) => ({ itemId: candidate.itemId, name: candidate.name, reason: candidate.reason })),
    };
  });

  /** Record what the person did with a suggestion. Only a pending row changes, and the same outcome again is a no-op. */
  app.post("/api/ai/judgments/:id/outcome", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(z.object({ outcome: z.enum(["ACCEPTED", "CORRECTED", "IGNORED"]), value: z.unknown().optional() }), request.body);
    const existing = await db.aiJudgment.findUnique({ where: { id } });
    if (!existing) throw new DomainError("That judgment was not found", 404);
    if (existing.outcome === body.outcome) return existing;
    if (existing.outcome !== "PENDING") throw new DomainError("That judgment already has an outcome", 409);
    const updated = await db.aiJudgment.updateMany({
      where: { id, outcome: "PENDING" },
      data: {
        outcome: body.outcome,
        ...(body.value !== undefined ? { outcomeValue: body.value as Prisma.InputJsonValue } : {}),
      },
    });
    const row = await db.aiJudgment.findUnique({ where: { id } });
    if (!row) throw new DomainError("That judgment was not found", 404);
    if (updated.count === 0 && row.outcome !== body.outcome) throw new DomainError("That judgment already has an outcome", 409);
    return row;
  });
}
