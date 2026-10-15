import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { buildMessages, parseSpec } from "../src/index.js";

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
  assert.equal(parseSpec({ ...spec, doneWhen: ["a", "b", "c", "d"] }), null);
  assert.equal(parseSpec({ ...spec, problem: "x".repeat(501) }), null);
  assert.equal(parseSpec({ ...spec, doneWhen: [] }), null);
  assert.deepEqual(parseSpec(JSON.stringify(spec)), spec);
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
