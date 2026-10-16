import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../preflight.mjs";
const SHA = "a3f40a8d0000000000000000000000000000000";
const runner = (over = {}) => async (cmd, args) => {
  const key = `${cmd} ${args.join(" ")}`;
  for (const [k, v] of Object.entries(over)) if (key.includes(k)) return v;
  if (key.includes("rev-parse")) return { code: 0, stdout: `${SHA}\n`, stderr: "" };
  if (key.includes("statusline_agents")) return { code: 0, stdout: '{"primary":{"used_percent":38},"secondary":{"used_percent":40}}', stderr: "" };
  if (key === "local-llm status") return { code: 0, stdout: "mode: q36-hybrid  unit: active\nhealth: ok", stderr: "" };
  if (key.includes("docker inspect profitindex-app-1")) return { code: 0, stdout: "sha256:live\n", stderr: "" };
  if (key.includes("docker image inspect")) return { code: 0, stdout: "NODE_ENV=production\nAPP_VERSION=a3f40a8\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const health = (build) => async () => new Response(JSON.stringify({ ok: true, build }));
const cfg = { repo: "/r", branch: "b", api: "http://a", implLane: "codex", timeouts: { model: 1000 } };
const journal = (h = null) => ({ halted: () => h });
test("local preflight checks local-llm status and skips the Codex quota call", async () => {
  const calls = [];
  const delegate = runner();
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: async (cmd, args) => { calls.push({ cmd, args }); return delegate(cmd, args); } });
  assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("statusline_agents"))), false, "local lane must not query Codex quota");
  assert.deepEqual(calls.filter(({ cmd }) => cmd === "local-llm"), [{ cmd: "local-llm", args: ["status"] }]);
  assert.deepEqual(out, { ok: true, base: SHA, short: "a3f40a8", baseImage: "sha256:live", lane: "local" });
});
test("GPU busy falls back to Codex when it has quota", async () => {
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: runner({ "local-llm status": { code: 0, stdout: "mode: q36-cpu  unit: active\nhealth: ok", stderr: "" } }) });
  assert.deepEqual(out, { ok: true, base: SHA, short: "a3f40a8", baseImage: "sha256:live", lane: "codex" });
});
test("GPU busy and Codex out of quota is a neutral skip", async () => {
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: runner({ "local-llm status": { code: 0, stdout: "mode: q36-cpu  unit: active\nhealth: ok", stderr: "" },
      statusline_agents: { code: 0, stdout: '{"primary":{"used_percent":100},"secondary":{"used_percent":40}}', stderr: "" } }) });
  assert.deepEqual(out, { ok: false, neutral: true, reason: "skipped: GPU busy and Codex unavailable (codex quota: 5h window at 100%)" });
});
test("CPU mode with health down falls back to Codex when it has quota", async () => {
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: runner({ "local-llm status": { code: 0, stdout: "mode: q36-cpu  unit: activating\nhealth: down", stderr: "" } }) });
  assert.deepEqual(out, { ok: true, base: SHA, short: "a3f40a8", baseImage: "sha256:live", lane: "codex" });
});
test("CPU mode with health down and no Codex quota is a neutral skip", async () => {
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: runner({ "local-llm status": { code: 0, stdout: "mode: q36-cpu  unit: activating\nhealth: down", stderr: "" },
      statusline_agents: { code: 0, stdout: '{"primary":{"used_percent":100},"secondary":{"used_percent":40}}', stderr: "" } }) });
  assert.deepEqual(out, { ok: false, neutral: true, reason: "skipped: GPU busy and Codex unavailable (codex quota: 5h window at 100%)" });
});
test("local preflight rejects hybrid status without health: ok", async () => {
  const out = await preflight({ cfg: { ...cfg, implLane: "local" }, journal: journal(), fetchImpl: health("a3f40a8"),
    runner: runner({ "local-llm status": { code: 0, stdout: "mode: q36-hybrid  unit: active\nhealth: failed", stderr: "" } }) });
  assert.deepEqual(out, { ok: false, reason: "local model not healthy" });
});
test("passes when the live build is the deploy tip and Codex has quota", async () => {
  assert.deepEqual(await preflight({ cfg, journal: journal(), runner: runner(), fetchImpl: health("a3f40a8") }), { ok: true, base: SHA, short: "a3f40a8", baseImage: "sha256:live", lane: "codex" });
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
