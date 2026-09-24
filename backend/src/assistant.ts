import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, badRequest } from "./errors";
import { routeWithJev, SCREENS } from "./jev";

/**
 * The Stockroom assistant: a copilot, not an autopilot.
 *
 * It READS freely — but only through the app's own GET endpoints, called as the
 * signed-in user, so it can never see more than that person could click to.
 * It never WRITES. Anything that would change stock or money comes back as a
 * proposal: a method, a path and a body that the UI shows as a card, and that
 * the user's own browser sends if they press Approve. The server then applies
 * every guard it applies to a click, because it IS a click. The model is never
 * a second route into the books.
 *
 * Models: a chain, like nimrun's lanes. Benched 2026-09-24 on the real job (a
 * packing-slip photo → find the PO → propose the exact receipt), 3 runs each:
 *   zenmux google/gemini-3.6-flash   3/3  17–21 s   ← primary
 *   zenmux qwen/qwen3.8-flash        3/3  24–36 s   ← overflow, a different vendor
 *   zenmux google/gemini-3.8-flash   3/3  22–29 s   (same upstream as the primary)
 *   zenmux anthropic/claude-haiku    1/3            (fast, wrong quantities)
 *   Google direct 3.6 / 3.8          429 / 503      (that key is throttled like a free tier)
 *   zenmux z-ai/glm-4.6v-flash-free  429 on call 1  (free tiers are not a dependency)
 * The overflow is deliberately NOT another Google route: the day's failures
 * were Google-side, and a fallback that shares the outage is not one.
 */

const PROVIDERS: Record<string, { url: string; keyEnv: string }> = {
  zenmux: { url: "https://zenmux.ai/api/v1/chat/completions", keyEnv: "ZENMUX_KEY" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "ASSISTANT_KEY" },
};
const DEFAULT_CHAIN = "zenmux:google/gemini-3.6-flash,zenmux:qwen/qwen3.8-flash,google:gemini-3.6-flash";

type Step = { provider: string; model: string; url: string; key: string };

/** The configured chain, keeping only steps whose key is present. */
function chain(): Step[] {
  return (process.env.ASSISTANT_CHAIN || DEFAULT_CHAIN)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((spec) => {
      const i = spec.indexOf(":");
      const provider = spec.slice(0, i);
      const model = spec.slice(i + 1);
      const p = PROVIDERS[provider];
      const key = p ? process.env[p.keyEnv] : undefined;
      return p && key && model ? [{ provider, model, url: p.url, key }] : [];
    });
}
const MAX_ROUNDS = 6;
const TOOL_RESULT_CHARS = 6000;

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type Proposal = { id: string; title: string; summary: string; method: "POST"; path: string; body: unknown };

/** GETs the assistant may make. Prefix match on the path before any query string. */
const READABLE = [
  "/dashboard", "/products", "/inventory", "/warehouses", "/purchase-orders", "/sales-orders",
  "/close", "/close-history", "/reports/", "/receiving/capabilities", "/customers", "/vendors",
  "/trial-balance", "/stock-transfers", "/stock-adjustments", "/stock-counts",
];

/** Writes the assistant may PROPOSE. Each is an existing route a user can already click. */
const PROPOSABLE: { pattern: RegExp; what: string }[] = [
  { pattern: /^\/purchase-orders\/\d+\/receive$/, what: "receive goods on a purchase order" },
  { pattern: /^\/sales-orders\/\d+\/(pack|ship|pay|invoice)$/, what: "move a sales order along" },
  { pattern: /^\/sales-orders\/\d+\/returns$/, what: "record a customer return" },
  { pattern: /^\/sales-orders\/shipments\/\d+\/tracking$/, what: "record tracking or confirm delivery" },
  { pattern: /^\/stock-adjustments$/, what: "adjust stock with a reason" },
];

export const ASSISTANT_TOOLS = [
  {
    type: "function",
    function: {
      name: "api_get",
      description:
        "Read Stockroom data as the current user. Useful paths: /dashboard/attention (what needs doing), " +
        "/dashboard/search?q=<SKU, PO number, order number, serial, customer or vendor> (find anything), " +
        "/purchase-orders/<id> (lines with quantity and receivedQty), /sales-orders/<id>, " +
        "/inventory?search=<sku> (stock by warehouse), /warehouses, /close/<YYYY-MM> (month-end checks), " +
        "/receiving/capabilities.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path starting with /, may include a query string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_wiki",
      description: "Read one page of the Stockroom wiki (how a screen or workflow works, exact button names, rules).",
      parameters: {
        type: "object",
        properties: { page: { type: "string", description: "Page name from the wiki index, e.g. receiving" } },
        required: ["page"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup",
      description:
        "Find a record by anything a person would quote — PO number, order number, invoice, SKU, serial, " +
        "customer or vendor name — and get its FULL details in the same step (lines, quantities, receivedQty, " +
        "ids). Prefer this over api_get for finding things: it saves a step.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_action",
      description:
        "Prepare a change for the user to approve. You cannot make changes yourself; this shows the user a card " +
        "with Approve. Allowed: POST /purchase-orders/<id>/receive with body {lines:[{lineId,quantity}]}; " +
        "POST /sales-orders/<id>/pack|ship|pay|invoice with body {}; POST /sales-orders/<id>/returns with body " +
        "{reason, lines:[{lineId, quantity, disposition:'RESTOCK'|'WRITE_OFF'}]}; POST " +
        "/sales-orders/shipments/<id>/tracking with body {carrier?, trackingNumber?, delivered?}; POST " +
        "/stock-adjustments with body {productId, warehouseId, adjustmentType:'INCREASE'|'DECREASE', quantity, reason}. " +
        "Use real ids you have read. One proposal per distinct change.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short imperative, e.g. 'Receive 20 × XAG-B13960 on PO-002002'" },
          summary: { type: "string", description: "One or two sentences: what will change and anything the user should check" },
          path: { type: "string" },
          body: { type: "object" },
        },
        required: ["title", "summary", "path", "body"],
      },
    },
  },
];

export function systemPrompt(route: string) {
  return `You are the assistant inside ProfitIndex, an inventory and accounting app for a small brand that sells through Shopify, Amazon, wholesale and a showroom. The user is on the page ${route}.

What you do:
- Guide people through the app in plain, short language. Say which button to press and where it is.
- Find records and answer questions by READING with api_get. Never guess an id, quantity or status — read it.
- Prepare work with propose_action. You never change anything yourself; the user approves each proposal.

How-to knowledge lives in the ProfitIndex wiki. Its index is below; call read_wiki with a page name when you need the steps, button names or rules for an area. Do not guess button names — read the page.

${wikiIndex()}

Delivery photos: read the packing slip (vendor, PO number, SKUs, quantities). Use lookup with the PO number (it returns the PO's lines in one step), compare what arrived with what is outstanding (quantity − receivedQty per line), then propose ONE receipt for the quantities that arrived and say clearly what is short, extra or unmatched. If the photo is unreadable, say what you can and cannot see.

Be brief. Write PLAIN TEXT: no markdown, no asterisks, no # headings — the panel shows text as-is. Use "1." style numbered steps for instructions. Proposals appear as cards BELOW your message. Money is in cents in the data; show it as dollars.`;
}

// ---------------------------------------------------------------------------
// Model client, replaceable in tests.
// ---------------------------------------------------------------------------

type LlmMessage = Record<string, unknown>;
export type Llm = (messages: LlmMessage[], tools: unknown[]) => Promise<LlmMessage>;

let llmOverride: Llm | null = null;
export function setAssistantLlmForTests(fn: Llm | null) {
  llmOverride = fn;
}

export function assistantConfigured() {
  return Boolean(llmOverride || chain().length > 0);
}

/** Which chain step answered the last call, for the response and the logs. */
let lastModel = "";
/** Tokens each model reply cost, keyed by the reply object so concurrent turns cannot mix. */
const usageOf = new WeakMap<object, { input: number; output: number }>();

const chainLlm: Llm = async (messages, tools) => {
  const steps = chain();
  let last = "no model configured";
  for (const step of steps) {
    const google = step.model.includes("gemini");
    // Gemini's thought signatures are Gemini-only; another vendor may reject the
    // unknown field when a conversation falls over to it mid-turn.
    const sent = google ? messages : messages.map(({ extra_content: _drop, ...m }) => m);
    try {
      const res = await fetch(step.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${step.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: step.model,
          messages: sent,
          tools,
          ...(google ? { reasoning_effort: "low" } : {}),
        }),
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 429 || res.status >= 500) {
        last = `${step.provider}:${step.model} answered ${res.status}`;
        console.warn(`[assistant] ${last}; trying the next model`);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        last = `${step.provider}:${step.model} refused (${res.status}): ${text.slice(0, 160)}`;
        console.warn(`[assistant] ${last}`);
        continue;
      }
      const d = JSON.parse(text);
      const message = (Array.isArray(d) ? d[0] : d)?.choices?.[0]?.message;
      if (!message) {
        last = `${step.provider}:${step.model} returned no message`;
        continue;
      }
      lastModel = `${step.provider}:${step.model}`;
      const u = (Array.isArray(d) ? d[0] : d)?.usage ?? {};
      usageOf.set(message, { input: Number(u.prompt_tokens ?? 0), output: Number(u.completion_tokens ?? 0) });
      return message;
    } catch (e) {
      last = `${step.provider}:${step.model}: ${(e as Error).message}`;
      console.warn(`[assistant] ${last}`);
    }
  }
  throw new ApiError(503, `The assistant is busy right now (${last}). Try again in a minute.`);
};

// ---------------------------------------------------------------------------
// Reading as the user: an in-process loopback to the app's own routes.
// ---------------------------------------------------------------------------

let loopback: { app: Express; port: number } | null = null;

async function loopbackPort(app: Express) {
  if (loopback?.app === app) return loopback.port;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  loopback = { app, port: (server.address() as AddressInfo).port };
  return loopback.port;
}

type Caller = { session?: string; actAs?: string };

async function readAsUser(app: Express, caller: Caller, path: string) {
  const bare = path.split("?")[0];
  const allowed = READABLE.some((p) =>
    p.endsWith("/") ? bare.startsWith(p) : bare === p || bare.startsWith(p + "/")
  );
  if (!path.startsWith("/") || path.includes("..") || !allowed) {
    return { error: `Not readable by the assistant: ${path}` };
  }
  const port = await loopbackPort(app);
  const headers: Record<string, string> = {};
  // The outer HTTP Basic gate applies to every request, including this one.
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD) {
    headers.Authorization =
      "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASSWORD}`).toString("base64");
  }
  if (caller.session) headers["X-Stockroom-Session"] = caller.session;
  if (caller.actAs) headers["X-Act-As-Role"] = caller.actAs;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers });
  const text = await res.text();
  if (!res.ok) return { error: `${res.status}: ${text.slice(0, 300)}` };
  return text.length > TOOL_RESULT_CHARS ? text.slice(0, TOOL_RESULT_CHARS) + "…(truncated)" : text;
}

// ---------------------------------------------------------------------------
// The Stockroom wiki (Karpathy's LLM Wiki pattern): short markdown pages, one
// per area, compiled from the code and kept honest by a lint test. The model
// gets the index in its prompt and reads a page only when it needs one, which
// keeps every turn's prompt small — that is where the speed is.
// ---------------------------------------------------------------------------

// src/ when run with tsx, dist/src/ in production; the wiki sits at backend/wiki.
export const WIKI_DIR =
  [path.resolve(__dirname, "..", "wiki"), path.resolve(__dirname, "..", "..", "wiki")].find((d) =>
    fs.existsSync(path.join(d, "index.md"))
  ) ?? path.resolve(__dirname, "..", "wiki");

export function wikiPages(): string[] {
  try {
    return fs.readdirSync(WIKI_DIR).filter((f) => f.endsWith(".md") && f !== "index.md").map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

function wikiIndex() {
  try {
    return fs.readFileSync(path.join(WIKI_DIR, "index.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).join("\n");
  } catch {
    return "(the wiki is missing on this server)";
  }
}

function readWiki(page: string) {
  const slug = page.trim().toLowerCase().replace(/\.md$/, "").replace(/^\[\[|\]\]$/g, "");
  if (!wikiPages().includes(slug)) return { error: `No wiki page "${page}". Pages: ${wikiPages().join(", ")}` };
  return fs.readFileSync(path.join(WIKI_DIR, `${slug}.md`), "utf8");
}

/**
 * Search, then read the best match's detail in the same tool call. Every
 * delivery and most questions start with "find X, then open it" — two model
 * round-trips (~5 s each) collapsed into one.
 */
async function lookup(app: Express, caller: Caller, query: string) {
  if (!query) return { error: "Say what to look up" };
  const raw = await readAsUser(app, caller, `/dashboard/search?q=${encodeURIComponent(query)}`);
  if (typeof raw !== "string") return raw;
  let results: { kind: string; label: string; to: string }[] = [];
  try {
    results = JSON.parse(raw).results ?? [];
  } catch {
    return { error: "Search returned something unreadable" };
  }
  if (results.length === 0) return { results: [], note: `Nothing matches "${query}"` };
  const exact = results.find((r) => r.label.toLowerCase() === query.toLowerCase()) ?? results[0];
  const detailPath = /^\/(purchase-orders|sales-orders|products)\/\d+$/.test(exact.to) ? exact.to : null;
  const detail = detailPath ? await readAsUser(app, caller, detailPath) : null;
  return { results: results.slice(0, 8), detailOf: detailPath ? exact.label : null, detail };
}

/** Models add markdown even when told not to; the panel renders plain text. */
function plain(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function checkProposal(args: Record<string, unknown>): Proposal | { error: string } {
  const path = String(args.path ?? "");
  const title = String(args.title ?? "").slice(0, 160);
  const summary = String(args.summary ?? "").slice(0, 600);
  const body = args.body;
  if (!PROPOSABLE.some((p) => p.pattern.test(path))) {
    return { error: `Cannot propose ${path}. Allowed: ${PROPOSABLE.map((p) => p.what).join("; ")}.` };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
  if (JSON.stringify(body).length > 20_000) return { error: "body is too large" };
  if (!title) return { error: "a proposal needs a title" };
  return { id: randomUUID(), title, summary, method: "POST", path, body };
}

// ---------------------------------------------------------------------------
// One chat turn: the tool loop.
// ---------------------------------------------------------------------------

export async function chat(
  app: Express,
  caller: Caller,
  input: {
    messages: ChatTurn[];
    route: string;
    image?: string;
    /** Skip the Jev front door (the user pressed "Ask the assistant instead"). */
    full?: boolean;
    /** The client says the conversation is fresh or its last answer was a fast one. */
    fastOk?: boolean;
  }
) {
  if (!assistantConfigured()) {
    throw new ApiError(503, "The assistant is not configured on this server (ASSISTANT_KEY is not set)");
  }
  if (input.messages.length === 0 || input.messages[input.messages.length - 1].role !== "user") {
    throw badRequest("The conversation must end with a user message");
  }
  if (input.image && !/^data:image\/(jpeg|png|webp);base64,/.test(input.image)) {
    throw badRequest("The photo must be a JPEG, PNG or WebP data URL");
  }

  // ---- the front door ----------------------------------------------------
  // Text-only, and only where a quick answer cannot be taken out of context
  // (a fresh conversation, or one whose last answer was itself quick). A reply
  // like "yes, do that" must reach the model that knows what "that" is.
  const latestText = input.messages[input.messages.length - 1].content.trim();
  if (!input.image && !input.full && input.fastOk !== false && latestText) {
    const r = await routeWithJev(latestText, input.route);
    const none = { input: 0, output: 0, calls: 0 };
    if (r?.kind === "navigate" && r.screen && SCREENS[r.screen]) {
      return {
        reply: `That's the ${SCREENS[r.screen]} screen.`,
        proposals: [],
        looked: [`jev navigate ${r.screen}`],
        model: "jev",
        usage: none,
        fast: true,
        navigate: { to: r.screen, label: SCREENS[r.screen] },
      };
    }
    if (r?.kind === "howto" && r.page && wikiPages().includes(r.page)) {
      const page = String(readWiki(r.page));
      return {
        reply: plain(page.replace(/^# .*\n+/, "")),
        proposals: [],
        looked: [`jev wiki ${r.page}`],
        model: "jev",
        usage: none,
        fast: true,
        wikiPage: r.page,
      };
    }
  }

  const llm = llmOverride ?? chainLlm;
  const turnUsage = { input: 0, output: 0, calls: 0 };
  const history = input.messages.slice(-20);
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt(input.route) },
    ...history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
  ];
  const latest = history[history.length - 1];
  messages.push(
    input.image
      ? {
          role: "user",
          content: [
            { type: "text", text: latest.content || "Here is a photo." },
            { type: "image_url", image_url: { url: input.image } },
          ],
        }
      : { role: "user", content: latest.content }
  );

  const proposals: Proposal[] = [];
  const looked: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await llm(messages, ASSISTANT_TOOLS);
    const u = usageOf.get(reply);
    turnUsage.calls += 1;
    turnUsage.input += u?.input ?? 0;
    turnUsage.output += u?.output ?? 0;
    // Kept verbatim: Gemini attaches a thought signature to tool calls that
    // must be echoed back on the next request or it rejects the conversation.
    messages.push(reply);
    const calls = (reply.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined) ?? [];
    if (calls.length === 0) {
      return {
        reply: plain(String(reply.content ?? "")) || "Done.",
        proposals,
        looked,
        model: lastModel,
        usage: { ...turnUsage },
      };
    }
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* the result below tells the model its arguments were unreadable */
      }
      let result: unknown;
      if (call.function.name === "api_get") {
        const path = String(args.path ?? "");
        looked.push(path.split("?")[0]);
        result = await readAsUser(app, caller, path);
      } else if (call.function.name === "read_wiki") {
        const page = String(args.page ?? "");
        looked.push(`wiki ${page}`);
        result = readWiki(page);
      } else if (call.function.name === "lookup") {
        const q = String(args.query ?? "").trim();
        looked.push(`lookup ${q}`);
        result = await lookup(app, caller, q);
      } else if (call.function.name === "propose_action") {
        const checked = checkProposal(args);
        if ("error" in checked) result = checked;
        else {
          proposals.push(checked);
          result = { ok: true, shownToUser: checked.title };
        }
      } else {
        result = { error: `Unknown tool ${call.function.name}` };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  return {
    reply: "I ran out of steps before finishing. Here is what I prepared so far — ask me to continue.",
    proposals,
    looked,
  };
}
