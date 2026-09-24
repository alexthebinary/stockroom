/**
 * The assistant, over HTTP, with a scripted model.
 *
 * The model is replaced by a stub that plays a fixed conversation, because what
 * needs proving is not how clever Gemini is but what the SERVER lets any model
 * do: read only whitelisted GETs, as the signed-in user, and never write —
 * only propose writes from an allow-list. The stub deliberately tries things it
 * must not be allowed to do.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { setAssistantLlmForTests, type Llm } from "../src/assistant";

let app: Express;
let token: string;

beforeAll(async () => {
  ({ app, token } = await boot());
});
afterEach(() => setAssistantLlmForTests(null));

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

describe("assistant", () => {
  it("answers 503 when no model is configured", async () => {
    delete process.env.ASSISTANT_KEY;
    delete process.env.ZENMUX_KEY;
    const res = await as(app, token).post("/api/assistant/chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
    expect((await as(app, token).get("/api/assistant/status")).body.configured).toBe(false);
  });

  it("reads as the user through whitelisted GETs only, and only PROPOSES allowed writes", async () => {
    const seen: Record<string, unknown>[][] = [];
    const script: Llm = async (messages) => {
      seen.push(messages.map((m) => ({ ...m })));
      const round = seen.length;
      if (round === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            call("a", "api_get", { path: "/dashboard/attention" }),
            call("b", "api_get", { path: "/ledger-settings" }), // not on the read list
            call("c", "api_get", { path: "/../auth/users" }), // traversal
          ],
        };
      }
      if (round === 2) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            call("d", "propose_action", {
              title: "Receive 2 on PO 7", summary: "Two arrived.", path: "/purchase-orders/7/receive",
              body: { lines: [{ lineId: 1, quantity: 2 }] },
            }),
            call("e", "propose_action", {
              title: "Reverse an entry", summary: "no", path: "/journal-entries/1/reverse", body: {},
            }),
          ],
        };
      }
      return { role: "assistant", content: "Here is what needs doing, and one receipt to approve." };
    };
    setAssistantLlmForTests(script);

    const res = await as(app, token).post("/api/assistant/chat").send({
      messages: [{ role: "user", content: "What needs doing?" }],
      route: "/",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reply).toMatch(/one receipt/);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0].path).toBe("/purchase-orders/7/receive");
    expect(res.body.looked).toEqual(["/dashboard/attention", "/ledger-settings", "/../auth/users"]);

    // What the model was actually handed back for each read.
    const toolMsgs = seen[1].filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsgs[0]).toContain('"jobs"'); // real data, read through the app
    expect(toolMsgs[1]).toMatch(/Not readable/);
    expect(toolMsgs[2]).toMatch(/Not readable/);
    const refused = seen[2].filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(refused[refused.length - 1]).toMatch(/Cannot propose/);
  });

  it("the system prompt carries the page the user is on", async () => {
    let system = "";
    setAssistantLlmForTests(async (messages) => {
      system = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    });
    await as(app, token).post("/api/assistant/chat").send({ messages: [{ role: "user", content: "help" }], route: "/receive" });
    expect(system).toContain("/receive");
  });

  it("a full-size camera frame is not rejected for size (was a 413 on every real scan)", async () => {
    const big = "data:image/jpeg;base64," + "A".repeat(600_000);
    const res = await as(app, token).post("/api/receiving/scan").send({ lineId: 999999, image: big });
    // Before the fix this was a 500 "request entity too large" (the error handler
    // swallowed body-parser's 413). Either way the body never reached the route.
    expect(JSON.stringify(res.body)).not.toMatch(/too large/);
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(500);
    const assistant = await as(app, token)
      .post("/api/assistant/chat")
      .send({ messages: [{ role: "user", content: "" }], image: big });
    expect(JSON.stringify(assistant.body)).not.toMatch(/too large/);
    void prisma;
  });
});

describe("request body errors", () => {
  it("an oversized body is a 413 with a readable message, not a 500", async () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(9_000_000);
    const res = await as(app, token).post("/api/receiving/scan").send({ lineId: 1, image: huge });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/);
  });
});

describe("open beta guards", () => {
  it("asks search engines not to index anything", async () => {
    const res = await as(app, token).get("/api/health");
    expect(res.headers["x-robots-tag"]).toMatch(/noindex/);
    const robots = await as(app, token).get("/robots.txt");
    expect(robots.text).toContain("Disallow: /");
  });

  it("caps assistant turns per client", async () => {
    const { assistantRateLimitHit } = await import("../src/routes/assistant");
    const t0 = 1_000_000;
    let hit = false;
    for (let i = 0; i < 60; i++) hit = assistantRateLimitHit("test-client", t0 + i);
    expect(hit).toBe(false);
    expect(assistantRateLimitHit("test-client", t0 + 61)).toBe(true);
    expect(assistantRateLimitHit("test-client", t0 + 11 * 60_000)).toBe(false); // window rolled over
  });
});

describe("Jev front door", () => {
  const llmCalls: number[] = [];
  const countingLlm: Llm = async () => {
    llmCalls.push(1);
    return { role: "assistant", content: "full answer" };
  };
  afterEach(async () => {
    const { setJevForTests } = await import("../src/jev");
    setJevForTests(undefined);
    llmCalls.length = 0;
  });

  async function withJev(route: import("../src/jev").JevRoute | null) {
    const { setJevForTests } = await import("../src/jev");
    setJevForTests(async () => route);
    setAssistantLlmForTests(countingLlm);
  }
  const say = (content: string, extra: Record<string, unknown> = {}) =>
    as(app, token).post("/api/assistant/chat").send({ messages: [{ role: "user", content }], route: "/", ...extra });

  it("'take me to' answers instantly with a screen, no model call", async () => {
    await withJev({ kind: "navigate", screen: "/transfers", ms: 5 });
    const res = await say("go to transfers");
    expect(res.body.fast).toBe(true);
    expect(res.body.navigate).toEqual({ to: "/transfers", label: "Transfers" });
    expect(llmCalls).toHaveLength(0);
  });

  it("'how do I' answers instantly with the wiki page, no model call", async () => {
    await withJev({ kind: "howto", page: "returns", ms: 5 });
    const res = await say("how do I do a return?");
    expect(res.body.wikiPage).toBe("returns");
    expect(res.body.reply).toContain("Return items");
    expect(res.body.reply).not.toContain("**");
    expect(llmCalls).toHaveLength(0);
  });

  it("data and change requests, Jev failures, 'full', photos and follow-ups all reach the model", async () => {
    await withJev({ kind: "assistant", ms: 5 });
    expect((await say("how many spools do we have?")).body.reply).toBe("full answer");
    await withJev(null); // Jev down or unsure
    expect((await say("go to transfers")).body.reply).toBe("full answer");
    await withJev({ kind: "navigate", screen: "/transfers", ms: 5 });
    expect((await say("go to transfers", { full: true })).body.reply).toBe("full answer");
    expect((await say("go to transfers", { fastOk: false })).body.reply).toBe("full answer");
    expect((await say("", { image: "data:image/jpeg;base64,AAAA" })).body.reply).toBe("full answer");
    expect(llmCalls).toHaveLength(5);
  });

  it("an unknown screen or page from Jev is not trusted", async () => {
    await withJev({ kind: "navigate", screen: "/admin/secret", ms: 5 });
    expect((await say("open admin")).body.reply).toBe("full answer");
    await withJev({ kind: "howto", page: "../../etc/passwd", ms: 5 });
    expect((await say("how do I hack")).body.reply).toBe("full answer");
  });
});

describe("fewer model rounds", () => {
  it("a record the user names is looked up before the first model call", async () => {
    await prisma.product.create({ data: { sku: "PF-TEST-1", name: "Prefetch probe" } });
    let first: Record<string, unknown>[] = [];
    setAssistantLlmForTests(async (messages) => {
      if (first.length === 0) first = messages.map((m) => ({ ...m }));
      return { role: "assistant", content: "ok" };
    });
    const res = await as(app, token).post("/api/assistant/chat").send({
      messages: [{ role: "user", content: "how many PF-TEST-1 do we have?" }], route: "/", fastOk: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pre = first.find((m) => m.role === "system" && String(m.content).startsWith("Already looked up"));
    expect(String(pre?.content)).toContain("Prefetch probe");
    expect(res.body.looked).toContain("lookup PF-TEST-1");

    // Negative control: nothing named, nothing prefetched.
    first = [];
    await as(app, token).post("/api/assistant/chat").send({
      messages: [{ role: "user", content: "what needs doing?" }], route: "/", fastOk: false,
    });
    expect(first.some((m) => String(m.content).startsWith("Already looked up"))).toBe(false);
  });

  it("a round that only prepared accepted proposals ends the turn without another model call", async () => {
    let calls = 0;
    setAssistantLlmForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [call("p", "propose_action", { title: "Pack SO-1", summary: "Packs it.", path: "/sales-orders/1/pack", body: {} })],
        };
      }
      return { role: "assistant", content: "restating the card" };
    });
    const res = await as(app, token).post("/api/assistant/chat").send({
      messages: [{ role: "user", content: "pack it" }], route: "/", fastOk: false,
    });
    expect(res.body.proposals).toHaveLength(1);
    expect(calls).toBe(1);
    expect(res.body.reply).toMatch(/approve/);
  });
});

describe("streamed turns", () => {
  const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l));

  it("streams status, text as written, then the same result /chat returns", async () => {
    let round = 0;
    setAssistantLlmForTests(async (_m, _t, onText) => {
      round += 1;
      if (round === 1) {
        onText?.("let me check");
        return { role: "assistant", content: "let me check", tool_calls: [call("a", "api_get", { path: "/dashboard/attention" })] };
      }
      onText?.("Two things ");
      onText?.("need doing.");
      return { role: "assistant", content: "Two things need doing." };
    });
    const res = await as(app, token)
      .post("/api/assistant/chat/stream")
      .send({ messages: [{ role: "user", content: "what needs doing?" }], route: "/", fastOk: false })
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.on("data", (c: Buffer) => (data += c.toString()));
        r.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/ndjson/);
    const ev = events(res.body as string);
    expect(ev.map((e) => e.type)).toEqual(["text", "reset", "status", "text", "text", "done"]);
    expect(ev[2].text).toBe("Reading what needs attention…");
    expect(ev[ev.length - 1].result.reply).toBe("Two things need doing.");
    expect(ev[ev.length - 1].result.looked).toEqual(["/dashboard/attention"]);
  });

  it("a failure after the stream opens is an error line, not a hung response", async () => {
    setAssistantLlmForTests(async () => {
      throw new Error("upstream exploded with secret detail");
    });
    const res = await as(app, token)
      .post("/api/assistant/chat/stream")
      .send({ messages: [{ role: "user", content: "anything" }], route: "/", fastOk: false })
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.on("data", (c: Buffer) => (data += c.toString()));
        r.on("end", () => cb(null, data));
      });
    const ev = events(res.body as string);
    expect(ev[ev.length - 1]).toMatchObject({ type: "error", status: 500 });
    expect(JSON.stringify(ev)).not.toContain("secret detail");
  });

  it("validation still fails as plain JSON before any stream", async () => {
    const res = await as(app, token).post("/api/assistant/chat/stream").send({ messages: [] });
    expect(res.status).toBe(400);
  });
});
