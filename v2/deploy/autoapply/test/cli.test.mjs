import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("../autoapply.mjs", import.meta.url));
// A fake PATH: git/dispatch/claude/systemctl record their argv; the API is a tiny local HTTP server that records POSTs.
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), "cli-")); const bin = join(d, "bin"); mkdirSync(bin);
  for (const tool of ["dispatch", "claude", "systemctl"]) { writeFileSync(join(bin, tool), `#!/bin/sh\necho "$0 $*" >> ${d}/calls\nexit 0\n`); chmodSync(join(bin, tool), 0o755); }
  return { d, bin };
}
const start = (env, args = []) => new Promise((resolve) => { const p = spawn(process.execPath, [CLI, ...args], { env }); let out = ""; p.stdout.on("data", (x) => (out += x)); p.stderr.on("data", (x) => (out += x)); p.on("close", (code) => resolve({ code, out })); });
test("--dry-run survives the locked re-exec: no POSTs, no push", async () => {
  const { d, bin } = sandbox();
  const posts = [];
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => { if (req.method === "POST") posts.push(req.url); res.setHeader("content-type", "application/json"); res.end(req.url.startsWith("/api/health") ? '{"ok":true,"build":"0000000"}' : "[]"); });
  await new Promise((r) => srv.listen(0, r));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STATE_DIR: join(d, "state"), PI_REPO: join(d, "norepo"), PI_VAULT_LOGS: join(d, "vault"), NOTIFY_URL: "", PI_API: `http://127.0.0.1:${srv.address().port}`, AUTO_TOKEN: "t" };
  const r = await start(env, ["--dry-run"]);
  srv.close();
  assert.equal(posts.length, 0, r.out);
  assert.ok(!existsSync(join(d, "calls")) || !readFileSync(join(d, "calls"), "utf8").includes("push"));
  assert.match(r.out, /DRY RUN/);
  assert.ok(existsSync(join(d, "vault")), "the report goes to the vault dir it was given, never the real vault");
});
test("a second invocation while one holds the run lock exits 0 without running", async () => {
  const { d, bin } = sandbox(); const stateDir = join(d, "state", "profitindex-autoapply"); mkdirSync(stateDir, { recursive: true });
  const hold = spawn("flock", [join(stateDir, "run.lock"), "sleep", "5"]);
  await new Promise((r) => setTimeout(r, 300));
  const r = await start({ ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STATE_DIR: join(d, "state"), PI_REPO: join(d, "norepo"), PI_VAULT_LOGS: join(d, "vault"), NOTIFY_URL: "" });
  hold.kill();
  assert.equal(r.code, 0);
  assert.ok(!existsSync(join(stateDir, "runs.jsonl")), "no run was journaled");
});
