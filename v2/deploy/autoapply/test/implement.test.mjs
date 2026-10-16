import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementNote } from "../implement.mjs";
import { run } from "../run.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
function repo() {
  const d = mkdtempSync(join(tmpdir(), "impl-")); const r = join(d, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  mkdirSync(join(r, "v2/apps/api/test"), { recursive: true }); writeFileSync(join(r, "v2/apps/api/a.ts"), "1\n"); writeFileSync(join(r, "v2/apps/api/test/.keep"), ""); // git does not track empty dirs
  git(r, "add", "-A"); git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const dumps = join(d, "rc/backups"); mkdirSync(dumps, { recursive: true }); writeFileSync(join(dumps, "p.dump"), "x");
  return { r, cfg: { repo: r, workDir: join(d, "work"), receiptsDir: join(d, "rc"), timeouts: { codex: 5000, gate: 5000, migration: 5000, model: 5000 } } };
}
const calls = [];
const fake = (edit, { gate = 0, migration = 0 } = {}) => async (cmd, args, opts) => {
  calls.push([cmd, ...args].join(" "));
  if (cmd === "dispatch") { edit(args.find((a) => a.startsWith("--cd=")).slice(5)); return { code: 0, stdout: "status:  answered\n", stderr: "" }; }
  if (cmd === "sh" && args[0].endsWith("migration-gate.sh")) return { code: migration, stdout: "", stderr: "base image: GET /api/items 500" };
  if (cmd === "sh" && args[0].endsWith("/gate.sh")) return { code: gate, stdout: "tests: 1 failed", stderr: "" };
  return run(cmd, args, opts);
};
const note = { id: 9, kind: "IDEA", revision: 4, note: "n" };
const spec = { problem: "p", expected: "Remember the brand filter", where: "/items", doneWhen: ["d"] };
const pass = async () => ({ pass: true, reasons: "ok" });
const withTest = (wt) => { writeFileSync(join(wt, "v2/apps/api/a.ts"), "2\n"); writeFileSync(join(wt, "v2/apps/api/test/a.test.ts"), "t\n"); };

test("a passing candidate becomes one commit with trailers; the worktree is removed", async () => {
  const { r, cfg } = repo(); const parent = git(r, "rev-parse", "HEAD");
  const out = await implementNote({ note, spec, runId: "run1", parent, base: parent, baseImage: "sha256:base", cfg, runner: fake(withTest), reviewFn: pass });
  assert.equal(out.ok, true); assert.equal(out.migration, false);
  const body = git(r, "log", "-1", "--format=%B", out.sha);
  assert.match(body, /^feat\(v2\): Remember the brand filter \(feedback #9\)/);
  assert.match(body, /Auto-apply: run1/); assert.match(body, /Feedback-Revision: 9@4/);
  assert.equal(existsSync(join(cfg.workDir, "run1", "note-9")), false);
});

test("no test changed, failing gate, failing review are each a clean failure", async () => {
  const { r, cfg } = repo(); const parent = git(r, "rev-parse", "HEAD");
  const args = { note, spec, runId: "r", parent, base: parent, baseImage: "sha256:base", cfg };
  assert.deepEqual(await implementNote({ ...args, runner: fake((wt) => writeFileSync(join(wt, "v2/apps/api/a.ts"), "2\n")), reviewFn: pass }), { ok: false, reason: "no test changed" });
  assert.match((await implementNote({ ...args, runner: fake(withTest, { gate: 1 }), reviewFn: pass })).reason, /^tests failed/);
  assert.deepEqual(await implementNote({ ...args, runner: fake(withTest), reviewFn: async () => ({ pass: false, reasons: "adds an unrelated page" }) }), { ok: false, reason: "review: adds an unrelated page" });
});

test("the migration gate runs against the LIVE base image, for the run's cumulative schema", async () => {
  const { r, cfg } = repo(); const base = git(r, "rev-parse", "HEAD");
  const mig = (name) => (wt) => { mkdirSync(join(wt, `v2/apps/api/prisma/migrations/${name}`), { recursive: true }); writeFileSync(join(wt, `v2/apps/api/prisma/migrations/${name}/migration.sql`), "ALTER TABLE t ADD c int;"); writeFileSync(join(wt, `v2/apps/api/test/${name}.test.ts`), "t\n"); };
  const first = await implementNote({ note, spec, runId: "r", parent: base, base, baseImage: "sha256:live", cfg, runner: fake(mig("m1")), reviewFn: pass });
  assert.equal(first.migration, true);
  calls.length = 0;
  // a later note with NO migration of its own still gets the gate: the run's tree carries m1
  await implementNote({ note: { ...note, id: 10 }, spec, runId: "r", parent: first.sha, base, baseImage: "sha256:live", cfg, runner: fake(withTest), reviewFn: pass });
  assert.ok(calls.some((c) => c.includes("migration-gate.sh") && c.includes("sha256:live")));
  assert.match((await implementNote({ note: { ...note, id: 11 }, spec, runId: "r", parent: base, base, baseImage: "sha256:live", cfg, runner: fake(mig("m2"), { migration: 1 }), reviewFn: pass })).reason, /^migration not backward compatible/);
});

test("an untracked file from a failed note never reaches the next note", async () => {
  const { r, cfg } = repo(); const parent = git(r, "rev-parse", "HEAD");
  const leaky = (wt) => { writeFileSync(join(wt, "v2/apps/api/stray.sql"), "DROP TABLE t;"); withTest(wt); };
  await implementNote({ note, spec, runId: "r", parent, base: parent, baseImage: "i", cfg, runner: fake(leaky, { gate: 1 }), reviewFn: pass });
  let seen = null;
  await implementNote({ note: { ...note, id: 10 }, spec, runId: "r", parent, base: parent, baseImage: "i", cfg, runner: fake((wt) => { seen = existsSync(join(wt, "v2/apps/api/stray.sql")); withTest(wt); }), reviewFn: pass });
  assert.equal(seen, false);
});
