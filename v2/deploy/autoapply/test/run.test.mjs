import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../run.mjs";
test("returns code and output", async () => {
  const r = await run("sh", ["-c", "echo hi; exit 3"], { timeoutMs: 5000 });
  assert.deepEqual([r.code, r.stdout.trim(), r.timedOut], [3, "hi", false]);
});
test("kills the whole process group on timeout", async () => {
  const t0 = Date.now();
  const r = await run("sh", ["-c", "sleep 30 & sleep 30; wait"], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});
test("never passes ANTHROPIC_API_KEY to children", async () => {
  const r = await run("sh", ["-c", "echo ${ANTHROPIC_API_KEY:-unset}"], { env: { ...process.env, ANTHROPIC_API_KEY: "sk-x" }, timeoutMs: 5000 });
  assert.equal(r.stdout.trim(), "unset");
});
