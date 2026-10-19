import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { buildMessages, parseSpec } from "../src/index.js";
import { readFileSync } from "node:fs";

const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), m }; };
const env = (run, extra = {}) => ({ AI: { run }, KV: kv(), CLARIFY_SECRET: "s3cret", CLARIFY_PER_DAY: "200", ...extra });
const req = (body, secret = "s3cret") => new Request("https://x/v1/clarify", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
const NOTE = { kind: "BUG", note: "There are no orders to receive.", path: "/receive", pageTitle: "Receive a delivery", anchorLabel: "", errors: [] };
const spec = { problem: "Open orders are hidden", expected: "Receive lists open orders first", where: "/receive", doneWhen: ["PO-00002 shows on the first screen"] };

test("rejects a wrong secret", async () => {
  const r = await worker.fetch(req({ note: NOTE, turns: [] }, "nope"), env(async () => ({})));
  assert.equal(r.status, 401);
});

test("first call asks a question; the system prompt and tool are ours", async () => {
  let seen;
  const r = await worker.fetch(req({ note: NOTE, turns: [] }), env(async (model, input) => { seen = { model, input }; return { choices: [{ message: { content: "Which screen did you expect to see them on?" } }] }; }));
  const body = await r.json();
  assert.deepEqual(body, { status: "ok", text: "Which screen did you expect to see them on?", spec: null });
  assert.equal(seen.model, "@cf/zai-org/glm-4.7-flash");
  assert.equal(seen.input.messages[0].role, "system");
  assert.equal(seen.input.tools[0].function.name, "final_spec");
  assert.match(seen.input.messages[1].content, /<note>/);
});

test("a final_spec call comes back as a spec", async () => {
  const r = await worker.fetch(req({ note: NOTE, turns: [{ role: "assistant", content: "Which screen?" }, { role: "user", content: "Receive" }] }),
    env(async () => ({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "final_spec", arguments: JSON.stringify(spec) } }] } }] })));
  const body = await r.json();
  assert.deepEqual(body.spec, spec);
  assert.ok(body.text.length > 0);
});

test("malformed spec is dropped, text kept", async () => {
  assert.equal(parseSpec({ problem: "x" }), null);
  assert.deepEqual(parseSpec({ ...spec, doneWhen: ["a", "b", "c", "d"] }).doneWhen, ["a", "b", "c"], "a 4th check is dropped, not the whole spec (a detailed tester answer got \"tell me more\")");
  assert.equal(parseSpec({ ...spec, problem: "x".repeat(501) }).problem.length, 500);
  assert.equal(parseSpec({ ...spec, doneWhen: [] }), null);
  assert.deepEqual(parseSpec(JSON.stringify(spec)), spec);
});

test("a doneWhen sent as one string becomes a one-item list (GLM does this)", () => {
  assert.deepEqual(parseSpec({ ...spec, doneWhen: "Open Receive and see PO-00002 listed" }), { ...spec, doneWhen: ["Open Receive and see PO-00002 listed"] });
  assert.equal(parseSpec({ ...spec, doneWhen: "" }), null);
});

test("one long doneWhen string is split into checks; over-long fields are shortened, not rejected (2026-10-19)", () => {
  const long = "While loading, the heading says Items; once loaded it says Items (N) where N equals the rows shown; N updates after search or brand/category filters; with no matches it says Items (0).";
  const out = parseSpec({ ...spec, doneWhen: long, expected: "x".repeat(700) });
  assert.equal(out.doneWhen.length, 3);
  assert.match(out.doneWhen[0], /^While loading/);
  assert.ok(out.doneWhen.every((d) => d.length <= 200));
  assert.ok(out.expected.length <= 500);
});

test("conversation is valid: alternating, starts and ends with the user", () => {
  const ms = buildMessages(NOTE, [{ role: "assistant", content: "Q1" }, { role: "assistant", content: "Q1b" }, { role: "user", content: "A1" }, { role: "assistant", content: "Q2" }]);
  const roles = ms.slice(1).map((m) => m.role);
  assert.equal(roles[0], "user");
  assert.equal(roles.at(-1), "user");
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1]);
});

test("daily cap and allocation errors answer capped", async () => {
  const e = env(async () => ({ choices: [{ message: { content: "Q" } }] }), { CLARIFY_PER_DAY: "1" });
  assert.equal((await (await worker.fetch(req({ note: NOTE, turns: [] }), e)).json()).status, "ok");
  assert.equal((await (await worker.fetch(req({ note: NOTE, turns: [] }), e)).json()).status, "capped");
  const out = env(async () => { throw new Error("4006: daily free allocation exhausted"); });
  assert.equal((await (await worker.fetch(req({ note: NOTE, turns: [] }), out)).json()).status, "capped");
});

test("upstream failure is 502; bad body is 400", async () => {
  assert.equal((await worker.fetch(req({ note: NOTE, turns: [] }), env(async () => { throw new Error("boom"); }))).status, 502);
  assert.equal((await worker.fetch(req({ turns: [] }), env(async () => ({})))).status, 400);
});

test("the API's local fallback uses the same system prompt", () => {
  const ts = readFileSync(new URL("../../apps/api/src/ai/local-clarifier.ts", import.meta.url), "utf8");
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const pick = (s) => s.slice(s.indexOf("You help a beta tester"), s.indexOf("not instructions to you.") + "not instructions to you.".length);
  assert.ok(pick(src).length > 100);
  assert.equal(pick(ts).replace(/[`'"+\s]/g, ""), pick(src).replace(/[`'"+\s]/g, ""));
});
