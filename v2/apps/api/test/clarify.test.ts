import { describe, expect, it } from "vitest";
import type { Clarifier, ClarifyResult, Spec } from "../src/ai/clarifier";
import { client, ok, sampleCompany } from "./helpers";

const SPEC: Spec = { problem: "Open orders are hidden", expected: "Receive lists them first", where: "/receive", doneWhen: ["PO shows on the first screen"] };
function scripted(...answers: ClarifyResult[]) {
  const calls: Parameters<Clarifier["clarify"]>[0][] = [];
  const c: Clarifier = { clarify: async (input) => { calls.push(structuredClone(input)); return answers.shift() ?? { ok: false, reason: "error" }; } };
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
    const confirmed = ok(await api.post(`/api/feedback/${id}/confirm`)).body;
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
    ok(await api.post(`/api/feedback/${id}/clarify`, { message: "orders hidden" }));
    ok(await api.post(`/api/feedback/${id}/confirm`));
    const re = ok(await api.post(`/api/feedback/${id}/clarify`, { message: "actually on the bill" })).body;
    expect(re).toMatchObject({ specState: "PROPOSED", spec: { where: "/bills" } });
    expect(re.revision).toBeGreaterThan(4);
  });

  it("confirm needs a proposed spec; a missing note is 404", async () => {
    const id = await note();
    expect((await client().post(`/api/feedback/${id}/confirm`)).status).toBe(409);
    expect((await client().post(`/api/feedback/999/clarify`, {})).status).toBe(404);
  });

  it("export.md shows the spec and the chat", async () => {
    const id = await note();
    const { c } = scripted({ ok: true, text: "Got it.", spec: SPEC });
    const api = client(undefined, null, c);
    ok(await api.post(`/api/feedback/${id}/clarify`, { message: "orders hidden" }));
    ok(await api.post(`/api/feedback/${id}/confirm`));
    const md = (await client().app.inject({ method: "GET", url: "/api/feedback/export.md" })).body;
    expect(md).toContain("Spec (confirmed):");
    expect(md).toContain("- Done when: PO shows on the first screen");
    expect(md).toContain("Tester: orders hidden");
    expect(md).toContain("AI: Got it.");
  });
});
