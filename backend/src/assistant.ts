import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { ApiError, badRequest } from "./errors";

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
 * Model: Gemini through its OpenAI-compatible endpoint (operator's choice,
 * 2026-09-24), with a fallback chain because 3.8 Flash answered 503 "high
 * demand" on every probe that day while 3.6 answered. Reasoning effort is low:
 * measured 5.7 s vs 18.8 s for the same photo + tool call.
 */

const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash";
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

const TOOLS = [
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

function systemPrompt(route: string) {
  return `You are the assistant inside Stockroom, an inventory and accounting app for a small brand that sells through Shopify, Amazon, wholesale and a showroom. The user is on the page ${route}.

What you do:
- Guide people through the app in plain, short language. Say which button to press and where it is.
- Find records and answer questions by READING with api_get. Never guess an id, quantity or status — read it.
- Prepare work with propose_action. You never change anything yourself; the user approves each proposal.

How the app works (use this to guide people):
- Receive (Operations): pick the arriving purchase order line and scan boxes, or open the PO and press Receive for a partial or full receipt. Serial-tracked products must be scanned box by box on the Receive screen.
- Sales orders: Pack reserves stock. Ship books cost and raises the invoice. Shopify/Amazon/Showroom orders are paid at checkout ("Take payment"); wholesale and direct orders are invoiced when they ship and are due in 30 days.
- Showroom sale (Operations): a walk-in client pays at the counter and leaves with the goods and a paid invoice.
- Returns: open the shipped order and press "Return items"; each unit goes back on the shelf or is written off; the customer is credited and refunded what they overpaid.
- Month-end close (Finance): every check that proves the month's stock and books are right; close the month when nothing blocks.
- Live Audit (bottom of the sidebar): passing means the ledger checks hold right now.

Delivery photos: read the packing slip (vendor, PO number, SKUs, quantities). Search for the PO, read it, compare what arrived with what is outstanding (quantity − receivedQty per line), then propose ONE receipt for the quantities that arrived and say clearly what is short, extra or unmatched. If the photo is unreadable, say what you can and cannot see.

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
  return Boolean(llmOverride || process.env.ASSISTANT_KEY);
}

const geminiLlm: Llm = async (messages, tools) => {
  const key = process.env.ASSISTANT_KEY!;
  const url = process.env.ASSISTANT_URL || DEFAULT_URL;
  const models = (process.env.ASSISTANT_MODELS || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
  let last = "no model configured";
  for (const model of models) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools, reasoning_effort: "low" }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 429 || res.status >= 500) {
        last = `${model} answered ${res.status}`;
        continue; // overloaded or rate-limited: the next model in the chain
      }
      const text = await res.text();
      if (!res.ok) throw new ApiError(502, `The assistant model refused the request (${res.status}): ${text.slice(0, 200)}`);
      const d = JSON.parse(text);
      const body = Array.isArray(d) ? d[0] : d;
      const message = body?.choices?.[0]?.message;
      if (!message) throw new ApiError(502, "The assistant model returned no message");
      return message;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      last = `${model}: ${(e as Error).message}`;
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
  input: { messages: ChatTurn[]; route: string; image?: string }
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

  const llm = llmOverride ?? geminiLlm;
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
    const reply = await llm(messages, TOOLS);
    // Kept verbatim: Gemini attaches a thought signature to tool calls that
    // must be echoed back on the next request or it rejects the conversation.
    messages.push(reply);
    const calls = (reply.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined) ?? [];
    if (calls.length === 0) {
      return { reply: plain(String(reply.content ?? "")) || "Done.", proposals, looked };
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
