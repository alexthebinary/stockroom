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

  it("drops a spec that fails validation, maps capped and errors", async () => {
    process.env.CLARIFY_URL = "https://w/v1/clarify"; process.env.CLARIFY_SECRET = "s";
    expect(await createClarifier(fakeFetch(200, { status: "ok", text: "Q?", spec: { problem: "p" } }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: true, text: "Q?", spec: null });
    expect(await createClarifier(fakeFetch(200, { status: "capped" }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "capped" });
    expect(await createClarifier(fakeFetch(502, { status: "error" }))!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
    const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await createClarifier(throwing)!.clarify({ note: NOTE, turns: [] })).toEqual({ ok: false, reason: "error" });
  });
});
