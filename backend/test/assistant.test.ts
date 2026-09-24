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
