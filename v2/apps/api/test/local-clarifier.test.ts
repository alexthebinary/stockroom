import { describe, expect, it } from "vitest";
import { withFallback, type Clarifier } from "../src/ai/clarifier";
import { createLocalClarifier } from "../src/ai/local-clarifier";

const NOTE = { kind: "BUG", note: "No orders", path: "/receive", pageTitle: null, anchorLabel: "", errors: [] };
const SPEC = { problem: "p", expected: "e", where: "/receive", doneWhen: ["d"] };
const ok = (text: string): Clarifier => ({ clarify: async () => ({ ok: true, text, spec: null }) });
const down: Clarifier = { clarify: async () => ({ ok: false, reason: "capped" }) };

describe("clarify fallback", () => {
  it("uses the backup only when the primary is unavailable", async () => {
    expect(await withFallback(ok("worker"), ok("local"))!.clarify({ note: NOTE, turns: [] })).toMatchObject({ text: "worker" });
    expect(await withFallback(down, ok("local"))!.clarify({ note: NOTE, turns: [] })).toMatchObject({ text: "local" });
    expect(await withFallback(null, ok("local"))!.clarify({ note: NOTE, turns: [] })).toMatchObject({ text: "local" });
    expect(withFallback(null, null)).toBeNull();
  });

  it("local: sends the shared prompt + final_spec tool, reads a tool call with doneWhen as a string", async () => {
    let body: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "final_spec", arguments: JSON.stringify({ ...SPEC, doneWhen: "d" }) } }] } }] }));
    }) as unknown as typeof fetch;
    const out = await createLocalClarifier("http://llm:8081", fetchImpl).clarify({ note: NOTE, turns: [{ role: "assistant", content: "Which screen?" }, { role: "user", content: "Receive" }] });
    expect(out).toEqual({ ok: true, text: expect.any(String), spec: SPEC });
    expect(body!.messages[0]!.role).toBe("system");
    expect(body!.messages[1]!.content).toContain("<note>");
    expect(body!.tools[0]!.function.name).toBe("final_spec");
  });

  it("local: a slow or broken model is unavailable, not an error page", async () => {
    const broken = (async () => new Response("<html>", { status: 500 })) as unknown as typeof fetch;
    expect(await createLocalClarifier("http://llm:8081", broken).clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
  });

  it("local: runs as the fallback when the Worker answers error, and never truncates a spec", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "final_spec", arguments: JSON.stringify({ ...SPEC, doneWhen: ["a", "b", "c", "d"] }) } }] } }] }))) as unknown as typeof fetch;
    const errored: Clarifier = { clarify: async () => ({ ok: false, reason: "error" }) };
    const out = await withFallback(errored, createLocalClarifier("http://llm:8081", fetchImpl))!.clarify({ note: NOTE, turns: [], questionsAsked: 2, finish: true });
    expect(out).toMatchObject({ ok: true, spec: { doneWhen: ["a", "b", "c; d"] } });
  });

  it("local: an invalid final_spec or an empty reply is an error, so nothing is faked", async () => {
    const bad = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "final_spec", arguments: JSON.stringify({ ...SPEC, problem: "x".repeat(900) }) } }] } }] }))) as unknown as typeof fetch;
    expect(await createLocalClarifier("http://llm:8081", bad).clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
    const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }))) as unknown as typeof fetch;
    expect(await createLocalClarifier("http://llm:8081", empty).clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
  });
});
