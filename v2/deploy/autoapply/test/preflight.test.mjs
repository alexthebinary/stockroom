import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../preflight.mjs";
const SHA = "a3f40a8d0000000000000000000000000000000";
const runner = (over = {}) => async (cmd, args) => {
  const key = `${cmd} ${args.join(" ")}`;
  for (const [k, v] of Object.entries(over)) if (key.includes(k)) return v;
  if (key.includes("rev-parse")) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
  if (key.includes("statusline_agents")) return { code: 0, stdout: '{"primary":{"used_percent":38},"secondary":{"used_percent":40}}', stderr: "" };
  if (key.includes("docker inspect profitindex-app-1")) return { code: 0, stdout: "sha256:live\n", stderr: "" };
  if (key.includes("docker image inspect")) return { code: 0, stdout: "NODE_ENV=production\nAPP_VERSION=a3f40a8\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const health = (build) => async () => new Response(JSON.stringify({ ok: true, build }));
const cfg = { repo: "/r", branch: "b", api: "http://a", timeouts: { model: 1000 } };
const journal = (h = null) => ({ halted: () => h });
test("passes when the live build is the deploy tip and Codex has quota", async () => {
  assert.deepEqual(await preflight({ cfg, journal: journal(), runner: runner(), fetchImpl: health("a3f40a8") }), { ok: true, base: SHA, short: "a3f40a8", baseImage: "sha256:live" });
});
test("preflight unhealthy: mid-deploy or down", async () => {
  assert.match((await preflight({ cfg, journal: journal(), runner: runner(), fetchImpl: health("0000000") })).reason, /not the deploy tip/);
  assert.match((await preflight({ cfg, journal: journal(), runner: runner(), fetchImpl: async () => { throw new Error("down"); } })).reason, /health/);
});
test("quota preflight: an exhausted Codex window stops the run before any claim", async () => {
  const r = await preflight({ cfg, journal: journal(), runner: runner({ "statusline_agents": { code: 0, stdout: '{"primary":{"used_percent":100},"secondary":{"used_percent":40}}', stderr: "" } }), fetchImpl: health("a3f40a8") });
  assert.deepEqual(r, { ok: false, reason: "codex quota: 5h window at 100%" });
});
test("quota preflight: unreadable output stops the run", async () => {
  const r = await preflight({ cfg, journal: journal(), runner: runner({ "statusline_agents": { code: 0, stdout: "not json", stderr: "" } }), fetchImpl: health("a3f40a8") });
  assert.deepEqual(r, { ok: false, reason: "codex quota unreadable" });
});
test("quota preflight: an exhausted secondary window stops the run", async () => {
  const r = await preflight({ cfg, journal: journal(), runner: runner({ "statusline_agents": { code: 0, stdout: '{"primary":{"used_percent":38},"secondary":{"used_percent":96}}', stderr: "" } }), fetchImpl: health("a3f40a8") });
  assert.deepEqual(r, { ok: false, reason: "codex quota: 7-day window at 96%" });
});
test("halted means no run", async () => {
  assert.match((await preflight({ cfg, journal: journal("abc"), runner: runner(), fetchImpl: health("a3f40a8") })).reason, /halted/);
});
