import { afterEach, describe, expect, it } from "vitest";
import { createClarifier } from "../src/ai/clarifier";

const NOTE = { kind: "BUG", note: "No orders", path: "/receive", pageTitle: null, anchorLabel: "", errors: [] };
const SPEC = { problem: "p", expected: "e", where: "/receive", doneWhen: ["d"] };
const fakeFetch = (status: number, body: unknown) => (async (url: string, init: RequestInit) => {
  fakeFetch.last = { url, init };
  return new Response(JSON.stringify(body), { status });
}) as unknown as typeof fetch;
fakeFetch.last = null as null | { url: string; init: RequestInit };

describe("the clarifier client", () => {
  afterEach(() => { delete process.env.CLARIFY_URL; delete process.env.CLARIFY_SECRET; });

  it("is off without both settings", () => {
    expect(createClarifier()).toBeNull();
    process.env.CLARIFY_URL = "https://w/v1/clarify";
    expect(createClarifier()).toBeNull();
  });

  it("sends the secret and returns text + a validated spec", async () => {
    process.env.CLARIFY_URL = "https://w/v1/clarify"; process.env.CLARIFY_SECRET = "s";
    const c = createClarifier(fakeFetch(200, { status: "ok", text: "Q?", spec: SPEC }))!;
    expect(await c.clarify({ note: NOTE, turns: [] })).toEqual({ ok: true, text: "Q?", spec: SPEC });
    expect((fakeFetch.last!.init.headers as Record<string, string>).authorization).toBe("Bearer s");
  });

  it("treats a spec that fails validation as an error (so the fallback runs), maps capped and errors", async () => {
    process.env.CLARIFY_URL = "https://w/v1/clarify"; process.env.CLARIFY_SECRET = "s";
    expect(await createClarifier(fakeFetch(200, { status: "ok", text: "Q?", spec: { problem: "p" } }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
    expect(await createClarifier(fakeFetch(200, { status: "capped" }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "capped" });
    expect(await createClarifier(fakeFetch(502, { status: "error" }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
    const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await createClarifier(throwing)!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
  });

  it("never passes a tool call written as text to the tester: a cut-off one is an error (fallback runs), a complete one becomes the spec", async () => {
    process.env.CLARIFY_URL = "https://w/v1/clarify"; process.env.CLARIFY_SECRET = "s";
    const cut = "<tool_call>final_spec<arg_key>problem</arg_key><arg_value>Weight uses kg</arg_value><arg_key>expected</arg_key><arg_value>Weight should accept and display";
    expect(await createClarifier(fakeFetch(200, { status: "ok", text: cut, spec: null }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
    const whole = "Got it.<tool_call>final_spec<arg_key>problem</arg_key><arg_value>p</arg_value><arg_key>expected</arg_key><arg_value>e</arg_value><arg_key>where</arg_key><arg_value>/receive</arg_value><arg_key>doneWhen</arg_key><arg_value>d</arg_value></tool_call>";
    expect(await createClarifier(fakeFetch(200, { status: "ok", text: whole, spec: null }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: true, text: "Got it.", spec: SPEC });
  });
});
