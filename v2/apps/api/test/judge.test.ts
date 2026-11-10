import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { bandOf, judge, type JudgeDb } from "../src/ai/judge";
import { ok, sampleCompany, testDb } from "./helpers";
import { deliver } from "./scan";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function memoryDb() {
  const rows: { id: number; question: string; subject: string; band: string; suggestion: unknown; model: string }[] = [];
  const db: JudgeDb = {
    aiJudgment: {
      async create({ data }) {
        const row = { id: rows.length + 1, question: data.question, subject: data.subject, band: data.band, suggestion: data.suggestion, model: data.model };
        rows.push(row);
        return { id: row.id };
      },
    },
  };
  return { db, rows };
}

const input = {
  key: "unknown_item_match",
  subject: "scan:1",
  state: { description: "blue box" },
  instructions: "Which item is this box?",
  criteria: { "7": "Sample Widget, SAMPLE-WIDGET" },
};

function answering(confidence: number, choice = "7", probabilities?: Record<string, number>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    expect(url).toBe(ENDPOINT);
    expect(JSON.parse(String(init?.body)).model).toBe("jev-latest");
    return new Response(JSON.stringify({
      model: "jev-1",
      answers: { unknown_item_match: { type: "choice", choice, confidence, probabilities: probabilities ?? { [choice]: confidence, none: 1 - confidence } } },
    }), { status: 200 });
  }) as typeof fetch;
}

describe("judge()", () => {
  it("bands HIGH, MEDIUM and NONE, and writes a row only when Jev answers", async () => {
    expect(bandOf(0.8)).toBe("HIGH");
    expect(bandOf(0.5)).toBe("MEDIUM");
    expect(bandOf(0.49)).toBe("NONE");
    const { db, rows } = memoryDb();
    const high = await judge(input, { fetch: answering(0.91), apiKey: "k", db });
    expect(high).toMatchObject({ id: 1, choice: "7", confidence: 0.91, band: "HIGH" });
    const medium = await judge(input, { fetch: answering(0.5), apiKey: "k", db });
    expect(medium?.band).toBe("MEDIUM");
    const none = await judge(input, { fetch: answering(0.49), apiKey: "k", db });
    expect(none).toMatchObject({ band: "NONE", choice: "7" });
    expect(rows.map((row) => row.band)).toEqual(["HIGH", "MEDIUM", "NONE"]);
    expect(rows[0]?.question).toBe("unknown_item_match");
    expect(rows[0]?.subject).toBe("scan:1");
    expect(rows[0]?.model).toBe("jev-1");

    const before = rows.length;
    expect(await judge(input, { fetch: answering(0.99), apiKey: "", db })).toBeNull();
    expect(await judge(input, { fetch: answering(0.99), apiKey: null, db })).toBeNull();
    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(signal?.reason ?? new Error("aborted"));
      if (!signal) return;
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    expect(await judge({ ...input, timeoutMs: 20 }, { fetch: hanging, apiKey: "k", db })).toBeNull();
    expect(await judge(input, { fetch: (async () => new Response("no", { status: 500 })) as typeof fetch, apiKey: "k", db })).toBeNull();
    expect(rows).toHaveLength(before);
  });

  it("asks one choice question and adds none when the caller did not", async () => {
    let body: { questions: { unknown_item_match: { type: string; criteria: Record<string, string> } } } | undefined;
    const fetchImpl: typeof fetch = (async (_url, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: "jev-1", answers: { unknown_item_match: { type: "choice", choice: "none", confidence: 0.2, probabilities: { none: 0.2 } } } }), { status: 200 });
    }) as typeof fetch;
    const { db } = memoryDb();
    const result = await judge(input, { fetch: fetchImpl, apiKey: "k", db });
    expect(result?.band).toBe("NONE");
    expect(body?.questions.unknown_item_match.type).toBe("choice");
    expect(body?.questions.unknown_item_match.criteria.none).toBeTruthy();
    expect(body?.questions.unknown_item_match.criteria["7"]).toContain("Sample Widget");
  });
});

function judgedClient(profileId: number, fetchImpl: typeof fetch, apiKey: string | null = "k") {
  const app = buildApp({ db: testDb(), reader: null, typesafeApiKey: apiKey, judgeFetch: fetchImpl });
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload: payload as never, headers: { "x-profile": String(profileId) } });
    const body = response.body ? JSON.parse(response.body) : null;
    return { status: response.statusCode, body };
  };
  return { get: (url: string) => call("GET", url), post: (url: string, payload?: unknown) => call("POST", url, payload ?? {}) };
}

function choiceFetch(choice: string, confidence: number, probabilities: Record<string, number>, onBody?: (body: { questions: { unknown_item_match: { criteria: Record<string, string> } } }) => void): typeof fetch {
  return (async (_url, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    onBody?.(body);
    return new Response(JSON.stringify({ model: "jev-1", answers: { unknown_item_match: { type: "choice", choice, confidence, probabilities } } }), { status: 200 });
  }) as typeof fetch;
}

describe("unknown-box suggestions", () => {
  it("offers purchase-order lines first, then this vendor's earlier items, and records the outcome once", async () => {
    const { ids, admin, clerk, profiles } = await sampleCompany();
    const acme = ok(await admin.post("/api/items", { sku: "ACME-1", name: "Acme Sprocket", brand: "Acme" })).body as { id: number };
    const hose = ok(await admin.post("/api/items", { sku: "HOSE", name: "Garden Hose" })).body as { id: number };
    const gadget = ok(await admin.post("/api/items", { sku: "GADGET", name: "Unrelated Gadget" })).body as { id: number };
    const otherVendor = ok(await admin.post("/api/vendors", { name: "Other Supplier" })).body as { id: number };
    const stranger = ok(await admin.post("/api/items", { sku: "STRANGER", name: "Other Vendor Item" })).body as { id: number };
    ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: acme.id, qtyOrdered: 2, unitCostCents: 100 }, { itemId: hose.id, qtyOrdered: 1, unitCostCents: 100 }] }));
    ok(await admin.post("/api/purchase-orders", { vendorId: otherVendor.id, warehouseId: ids.warehouse, lines: [{ itemId: stranger.id, qtyOrdered: 1, unitCostCents: 100 }] }));
    const po = ok(await admin.post("/api/purchase-orders", {
      vendorId: ids.supplier,
      warehouseId: ids.warehouse,
      lines: [
        { itemId: ids.widget, qtyOrdered: 4, unitCostCents: 50000 },
        { itemId: ids.openBox, qtyOrdered: 1, unitCostCents: 1000 },
        { itemId: ids.robot, qtyOrdered: 1, unitCostCents: 120000 },
      ],
    })).body as { id: number; number: string };
    const { session, submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier, poId: po.id }, [{ code: "NEW-THING-77", unknownName: "Acme sprocket loose", qty: 1 }]);
    ok(submitted);

    let criteria: Record<string, string> = {};
    const probabilities = { [String(ids.widget)]: 0.55, [String(hose.id)]: 0.2, [String(acme.id)]: 0.15, [String(ids.openBox)]: 0.05, none: 0.05 };
    const api = judgedClient(profiles.admin.id, choiceFetch(String(ids.widget), 0.86, probabilities, (body) => { criteria = body.questions.unknown_item_match.criteria; }));
    const found = ok(await api.get(`/api/ai/unknown-suggestions?sessionId=${session.id}&code=NEW-THING-77&name=${encodeURIComponent("Acme sprocket loose")}`));
    expect(Object.keys(criteria).sort()).toEqual([String(ids.widget), String(ids.openBox), String(hose.id), String(acme.id), "none"].sort());
    expect(criteria[String(ids.robot)]).toBeUndefined();
    expect(criteria[String(gadget.id)]).toBeUndefined();
    expect(criteria[String(stranger.id)]).toBeUndefined();
    expect(found.body.suggestions).toEqual([
      { itemId: ids.widget, name: "Sample Widget", reason: `On order ${po.number}` },
      { itemId: hose.id, name: "Garden Hose", reason: "Bought from this vendor before" },
      { itemId: acme.id, name: "Acme Sprocket", reason: "Same brand" },
    ]);
    const judgmentId = found.body.judgmentId as number;
    const saved = await testDb().aiJudgment.findUniqueOrThrow({ where: { id: judgmentId } });
    expect(saved).toMatchObject({ question: "unknown_item_match", subject: `scan:${session.id}`, band: "HIGH", outcome: "PENDING" });

    const accepted = ok(await api.post(`/api/ai/judgments/${judgmentId}/outcome`, { outcome: "ACCEPTED", value: { itemId: ids.widget } }));
    expect(accepted.body.outcome).toBe("ACCEPTED");
    expect(accepted.body.outcomeValue).toEqual({ itemId: ids.widget });
    const again = ok(await api.post(`/api/ai/judgments/${judgmentId}/outcome`, { outcome: "ACCEPTED" }));
    expect(again.body.outcome).toBe("ACCEPTED");
    expect(again.body.outcomeValue).toEqual({ itemId: ids.widget });
    const corrected = await api.post(`/api/ai/judgments/${judgmentId}/outcome`, { outcome: "CORRECTED", value: { itemId: ids.openBox } });
    expect(corrected.status).toBe(409);

    const low = judgedClient(profiles.admin.id, choiceFetch(String(ids.widget), 0.42, { [String(ids.widget)]: 0.42, none: 0.58 }));
    const empty = ok(await low.get(`/api/ai/unknown-suggestions?sessionId=${session.id}&code=NEW-THING-77&name=${encodeURIComponent("Acme sprocket loose")}`));
    expect(empty.body).toEqual({ judgmentId: null, suggestions: [] });
    const noneRow = await testDb().aiJudgment.findFirst({ where: { band: "NONE" }, orderBy: { id: "desc" } });
    expect(noneRow?.outcome).toBe("PENDING");

    let called = false;
    const missing = judgedClient(profiles.admin.id, (async () => { called = true; return new Response("no"); }) as typeof fetch, "");
    const quiet = ok(await missing.get(`/api/ai/unknown-suggestions?sessionId=${session.id}&code=NEW-THING-77`));
    expect(quiet.body).toEqual({ judgmentId: null, suggestions: [] });
    expect(called).toBe(false);
  });

  it("stops at eight candidates, purchase-order lines before vendor history", async () => {
    const { ids, admin, clerk, profiles } = await sampleCompany();
    const onOrder: number[] = [];
    for (let i = 0; i < 6; i++) onOrder.push((ok(await admin.post("/api/items", { sku: `PO-${i}`, name: `Ordered ${i}` })).body as { id: number }).id);
    const earlier: number[] = [];
    for (let i = 0; i < 4; i++) earlier.push((ok(await admin.post("/api/items", { sku: `OLD-${i}`, name: `Earlier ${i}` })).body as { id: number }).id);
    ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: earlier.map((itemId) => ({ itemId, qtyOrdered: 1, unitCostCents: 100 })) }));
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: onOrder.map((itemId) => ({ itemId, qtyOrdered: 1, unitCostCents: 100 })) })).body as { id: number };
    const { session, submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier, poId: po.id }, [{ code: "BOX-9", unknownName: "plain box" }]);
    ok(submitted);
    let keys: string[] = [];
    const fetchImpl = choiceFetch(String(onOrder[0]), 0.9, { [String(onOrder[0])]: 0.9, none: 0.1 }, (body) => { keys = Object.keys(body.questions.unknown_item_match.criteria); });
    ok(await judgedClient(profiles.admin.id, fetchImpl).get(`/api/ai/unknown-suggestions?sessionId=${session.id}&code=BOX-9&name=plain%20box`));
    const itemKeys = keys.filter((key) => key !== "none");
    expect(itemKeys).toHaveLength(8);
    expect(new Set(itemKeys)).toEqual(new Set([...onOrder.map(String), String(earlier[3]), String(earlier[2])]));
  });

  it("returns nothing when Jev picks none, even at high confidence", async () => {
    const { ids, admin, clerk, profiles } = await sampleCompany();
    const po = ok(await admin.post("/api/purchase-orders", { vendorId: ids.supplier, warehouseId: ids.warehouse, lines: [{ itemId: ids.widget, qtyOrdered: 1, unitCostCents: 100 }] })).body as { id: number };
    const { session, submitted } = await deliver(clerk, { warehouseId: ids.warehouse, vendorId: ids.supplier, poId: po.id }, [{ code: "NOPE", unknownName: "mug" }]);
    ok(submitted);
    const api = judgedClient(profiles.admin.id, choiceFetch("none", 0.93, { none: 0.93, [String(ids.widget)]: 0.07 }));
    const body = ok(await api.get(`/api/ai/unknown-suggestions?sessionId=${session.id}&code=NOPE&name=mug`)).body;
    expect(body).toEqual({ judgmentId: null, suggestions: [] });
  });
});

