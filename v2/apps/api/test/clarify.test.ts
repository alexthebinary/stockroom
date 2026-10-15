import { describe, expect, it, vi } from "vitest";
import type { Clarifier, ClarifyResult, Spec } from "../src/ai/clarifier";
import { client, ok, sampleCompany } from "./helpers";

const SPEC: Spec = { problem: "Open orders are hidden", expected: "Receive lists them first", where: "/receive", doneWhen: ["PO shows on the first screen"] };
function scripted(...answers: ClarifyResult[]) {
  const calls: Parameters<Clarifier["clarify"]>[0][] = [];
  const c: Clarifier = { clarify: async (input) => { calls.push(structuredClone(input)); return answers.shift() ?? { ok: false, reason: "error" }; } };
  return { c, calls };
}
function deferredClarifier() {
  const calls: { input: Parameters<Clarifier["clarify"]>[0]; resolve: (result: ClarifyResult) => void }[] = [];
  const c: Clarifier = {
    clarify: (input) => new Promise<ClarifyResult>((resolve) => {
      calls.push({ input: structuredClone(input), resolve });
    }),
  };
  return { c, calls };
}
async function note(text = "There are no orders to receive.") {
  await sampleCompany();
  return ok(await client().post("/api/feedback", { kind: "BUG", note: text, path: "/receive", author: "Serhii" }), 201).body.id as number;
}

describe("clarify my feedback", () => {
  it("asks a first question, takes answers, proposes a spec, and the tester confirms it", async () => {
    const id = await note();
    const { c, calls } = scripted({ ok: true, text: "Which screen?", spec: null }, { ok: true, text: "Here is what I understood.", spec: SPEC });
    const api = client(undefined, null, c);
    const first = ok(await api.post(`/api/feedback/${id}/clarify`, {})).body;
    expect(first).toMatchObject({ text: "Which screen?", spec: null, specState: "NONE", revision: 1 });
    expect(calls[0]!.note).toMatchObject({ note: "There are no orders to receive.", path: "/receive" });
    const second = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "Receive, first screen" })).body;
    expect(second).toMatchObject({ spec: SPEC, specState: "PROPOSED", revision: 3 });
    expect(second.turns.map((t: { role: string }) => t.role)).toEqual(["assistant", "user", "assistant"]);
    expect(calls[1]!.turns.at(-1)).toEqual({ role: "user", content: "Receive, first screen" });
    const confirmed = ok(await api.post(`/api/feedback/${id}/confirm`, { revision: second.revision })).body;
    expect(confirmed).toMatchObject({ specState: "CONFIRMED", revision: 4 });
    const row = ok(await api.get("/api/feedback")).body[0];
    expect(row).toMatchObject({ spec: SPEC, specState: "CONFIRMED", autoState: "NONE", revision: 4, turnCount: 3 });
  });

  it("no re-ask: opening the chat again does not call the model", async () => {
    const id = await note();
    const { c, calls } = scripted({ ok: true, text: "Which screen?", spec: null });
    const api = client(undefined, null, c);
    ok(await api.post(`/api/feedback/${id}/clarify`, {}));
    const again = ok(await api.post(`/api/feedback/${id}/clarify`, {})).body;
    expect(calls).toHaveLength(1);
    expect(again.turns).toHaveLength(1);
  });

  it("a late reply never overwrites a newer spec", async () => {
    const id = await note();
    const SPEC_A: Spec = { ...SPEC, where: "/orders" };
    const SPEC_B: Spec = { ...SPEC, where: "/bills" };
    const { c, calls } = deferredClarifier();
    const api = client(undefined, null, c);
    const a = api.post(`/api/feedback/${id}/clarify`, { message: "a" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const b = api.post(`/api/feedback/${id}/clarify`, { message: "b" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.resolve({ ok: true, text: "Spec B is ready.", spec: SPEC_B });
    const newer = ok(await b).body;
    expect(newer).toMatchObject({ spec: SPEC_B, specState: "PROPOSED" });
    ok(await api.post(`/api/feedback/${id}/confirm`, { revision: newer.revision }));
    calls[0]!.resolve({ ok: true, text: "Spec A is ready.", spec: SPEC_A });
    const late = ok(await a).body;
    const row = ok(await api.get("/api/feedback")).body.find((r: { id: number }) => r.id === id);
    expect(row).toMatchObject({ spec: SPEC_B, specState: "CONFIRMED" });
    expect(late.turns).not.toContainEqual({ role: "assistant", content: "Spec A is ready." });
  });

  it("two first opens ask one question", async () => {
    const id = await note();
    const { c, calls } = deferredClarifier();
    const api = client(undefined, null, c);
    const a = api.post(`/api/feedback/${id}/clarify`, {});
    const b = api.post(`/api/feedback/${id}/clarify`, {});
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) call.resolve({ ok: true, text: "Which screen?", spec: null });
    const replies = await Promise.all([a, b]);
    for (const reply of replies) ok(reply);
    const reopened = ok(await api.post(`/api/feedback/${id}/clarify`, {})).body;
    expect(reopened.turns).toEqual([{ role: "assistant", content: "Which screen?" }]);
    expect(ok(await api.get("/api/feedback")).body[0].turnCount).toBe(1);
  });

  it("confirm refuses a spec the tester did not see", async () => {
    const id = await note();
    const SPEC_B: Spec = { ...SPEC, where: "/bills" };
    const { c } = scripted({ ok: true, text: "Spec A.", spec: SPEC }, { ok: true, text: "Spec B.", spec: SPEC_B });
    const api = client(undefined, null, c);
    const first = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "orders hidden" })).body;
    const second = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "actually on the bill" })).body;
    expect(second.revision).toBeGreaterThan(first.revision);
    expect((await api.post(`/api/feedback/${id}/confirm`, { revision: first.revision })).status).toBe(409);
    expect(ok(await api.get("/api/feedback")).body[0]).toMatchObject({ spec: SPEC_B, specState: "PROPOSED", revision: second.revision });
    expect(ok(await api.post(`/api/feedback/${id}/confirm`, { revision: second.revision })).body).toMatchObject({ spec: SPEC_B, specState: "CONFIRMED" });
  });

  it("a saved answer gets its reply once the AI is back", async () => {
    const id = await note();
    const { c: capped } = scripted({ ok: false, reason: "capped" });
    const saved = ok(await client(undefined, null, capped).post(`/api/feedback/${id}/clarify`, { message: "x" })).body;
    expect(saved).toMatchObject({ unavailable: true, turns: [{ role: "user", content: "x" }] });
    const { c, calls } = scripted({ ok: true, text: "Thanks, which screen?", spec: null });
    const api = client(undefined, null, c);
    const resumed = ok(await api.post(`/api/feedback/${id}/clarify`, {})).body;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.turns).toEqual([{ role: "user", content: "x" }]);
    expect(resumed.turns).toEqual([{ role: "user", content: "x" }, { role: "assistant", content: "Thanks, which screen?" }]);
    const reopened = ok(await api.post(`/api/feedback/${id}/clarify`, {})).body;
    expect(calls).toHaveLength(1);
    expect(reopened.turns).toEqual(resumed.turns);
  });

  it("unavailable: the message is kept and the tester is told", async () => {
    const id = await note();
    const { c } = scripted({ ok: false, reason: "capped" });
    const out = ok(await client(undefined, null, c).post(`/api/feedback/${id}/clarify`, { message: "It is on Receive" })).body;
    expect(out).toMatchObject({ unavailable: true, text: "I'll ask you later — your note is saved.", revision: 2 });
    expect(out.turns).toEqual([{ role: "user", content: "It is on Receive" }]);
    const off = ok(await client().post(`/api/feedback/${id}/clarify`, { message: "still there" })).body;
    expect(off.unavailable).toBe(true);
  });

  it("reopen: a message after confirming reopens the spec at a new revision", async () => {
    const id = await note();
    const { c } = scripted({ ok: true, text: "Got it.", spec: SPEC }, { ok: true, text: "Updated.", spec: { ...SPEC, where: "/bills" } });
    const api = client(undefined, null, c);
    const proposed = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "orders hidden" })).body;
    ok(await api.post(`/api/feedback/${id}/confirm`, { revision: proposed.revision }));
    const re = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "actually on the bill" })).body;
    expect(re).toMatchObject({ specState: "PROPOSED", spec: { where: "/bills" } });
    expect(re.revision).toBeGreaterThan(4);
  });

  it("confirm needs a proposed spec; a missing note is 404", async () => {
    const id = await note();
    const current = ok(await client().post(`/api/feedback/${id}/clarify`, {})).body;
    expect((await client().post(`/api/feedback/${id}/confirm`, { revision: current.revision })).status).toBe(409);
    expect((await client().post(`/api/feedback/999/clarify`, {})).status).toBe(404);
  });

  it("export.md shows the spec and the chat", async () => {
    const id = await note();
    const { c } = scripted({ ok: true, text: "Got it.", spec: SPEC });
    const api = client(undefined, null, c);
    const proposed = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "orders hidden" })).body;
    ok(await api.post(`/api/feedback/${id}/confirm`, { revision: proposed.revision }));
    const md = (await client().app.inject({ method: "GET", url: "/api/feedback/export.md" })).body;
    expect(md).toContain("Spec (confirmed):");
    expect(md).toContain("- Done when: PO shows on the first screen");
    expect(md).toContain("Tester: orders hidden");
    expect(md).toContain("AI: Got it.");
  });

  it("listing includes ordered chat turns only when requested", async () => {
    const id = await note();
    const emptyId = ok(await client().post("/api/feedback", { kind: "IDEA", note: "Another note", path: "/items" }), 201).body.id;
    const { c } = scripted({ ok: true, text: "Which screen?", spec: null }, { ok: true, text: "Thanks.", spec: null });
    const api = client(undefined, null, c);
    ok(await api.post(`/api/feedback/${id}/clarify`, {}));
    ok(await api.post(`/api/feedback/${id}/clarify`, { message: "Receive" }));
    const plain = ok(await api.get("/api/feedback")).body;
    expect(plain).toHaveLength(2);
    for (const row of plain) expect(row).not.toHaveProperty("turns");
    const withTurns = ok(await api.get("/api/feedback?turns=1")).body;
    expect(withTurns.map((row: { id: number; turns: unknown }) => ({ id: row.id, turns: row.turns }))).toEqual([
      { id: emptyId, turns: [] },
      { id, turns: [{ role: "assistant", content: "Which screen?" }, { role: "user", content: "Receive" }, { role: "assistant", content: "Thanks." }] },
    ]);
  });
});
