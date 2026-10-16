import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
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
  return { r, cfg: { repo: r, implLane: "codex", workDir: join(d, "work"), receiptsDir: join(d, "rc"), timeouts: { codex: 5000, gate: 5000, migration: 5000, model: 5000 } } };
}
const calls = [];
const fake = (edit, { gate = 0, migration = 0, implementation = { code: 0, stdout: "status:  answered\n", stderr: "" } } = {}) => async (cmd, args, opts) => {
  calls.push([cmd, ...args].join(" "));
  if (cmd === "dispatch" || cmd === "codex") {
    const wt = cmd === "dispatch" ? args.find((a) => a.startsWith("--cd=")).slice(5) : args[args.indexOf("-C") + 1];
    edit(wt);
    return implementation;
  }
  if (cmd === "sh" && args[0].endsWith("migration-gate.sh")) return { code: migration, stdout: "", stderr: "base image: GET /api/items 500" };
  if (cmd === "sh" && args[0].endsWith("/gate.sh")) return { code: gate, stdout: "tests: 1 failed", stderr: "" };
  return run(cmd, args, opts);
};
const note = { id: 9, kind: "IDEA", revision: 4, note: "n" };
const spec = { problem: "p", expected: "Remember the brand filter", where: "/items", doneWhen: ["d"] };
const pass = async () => ({ pass: true, reasons: "ok" });
const withTest = (wt) => { writeFileSync(join(wt, "v2/apps/api/a.ts"), "2\n"); writeFileSync(join(wt, "v2/apps/api/test/a.test.ts"), "t\n"); };

test("local lane runs codex exec with the local responses provider and the prompt on stdin", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "local";
  const parent = git(r, "rev-parse", "HEAD");
  const delegate = fake(withTest);
  const modelCalls = [];
  const runner = async (cmd, args, opts) => {
    if (cmd === "dispatch" || cmd === "codex") modelCalls.push({ cmd, args, opts });
    return delegate(cmd, args, opts);
  };
  const out = await implementNote({ note, spec, runId: "local-argv", parent, base: parent, baseImage: "base", cfg, runner, reviewFn: pass });
  assert.equal(out.ok, true);
  assert.equal(modelCalls.length, 1);
  const { cmd, args, opts } = modelCalls[0];
  assert.equal(cmd, "codex");
  assert.deepEqual(args.slice(0, 6), ["exec", "--skip-git-repo-check", "-C", join(cfg.workDir, "local-argv", "note-9"), "-s", "workspace-write"]);
  const configEntries = args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);
  assert.ok(configEntries.includes("model_provider=localllm"));
  const provider = configEntries.find((entry) => entry.startsWith("model_providers.localllm="));
  assert.equal(typeof provider, "string", "local provider must be configured via -c");
  assert.match(provider, /base_url\s*=\s*"http:\/\/127\.0\.0\.1:8080\/v1"/);
  assert.match(provider, /wire_api\s*=\s*"responses"/);
  assert.ok(args.some((arg, i) => arg === "-m" && args[i + 1] === "local"));
  assert.equal(args.at(-1), "-");
  assert.ok(args.includes("model_context_window=32768") && args.includes("model_auto_compact_token_limit=24000"), "codex must know the local window and compact before it (dry run 2026-10-16 died at 32,784 tokens)");
  assert.equal(opts.timeoutMs, cfg.timeouts.codex);
  assert.equal(typeof opts.input, "string");
  assert.match(opts.input, /IMPLEMENT \(bounded\)/);
  assert.ok(opts.input.includes(`<note>${JSON.stringify({ id: note.id, kind: note.kind, note: note.note, path: note.path })}</note>`));
  assert.ok(opts.input.includes(`<spec>${JSON.stringify(spec)}</spec>`));
});

test("local lane accepts exit code zero without a dispatch answered marker", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "local";
  const parent = git(r, "rev-parse", "HEAD");
  const out = await implementNote({ note, spec, runId: "local-success", parent, base: parent, baseImage: "base", cfg,
    runner: fake(withTest, { implementation: { code: 0, stdout: "Done.\n", stderr: "", timedOut: false } }), reviewFn: pass });
  assert.equal(out.ok, true);
  assert.equal(git(r, "show", `${out.sha}:v2/apps/api/a.ts`), "2");
});

test("local lane reports a timed-out model as a local model failure", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "local";
  const parent = git(r, "rev-parse", "HEAD");
  const out = await implementNote({ note, spec, runId: "local-timeout", parent, base: parent, baseImage: "base", cfg,
    runner: fake(() => {}, { implementation: { code: null, stdout: "", stderr: "", timedOut: true } }), reviewFn: pass });
  assert.equal(out.ok, false);
  assert.match(out.reason, /^local model: timed out/);
});

test("F1: dispatch receives a prompt under tmpdir outside the worktree directory", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  const parent = git(r, "rev-parse", "HEAD");
  const delegate = fake(withTest);
  let promptFile;
  const runner = async (cmd, args, opts) => {
    if (cmd === "dispatch") promptFile = args.at(-1);
    return delegate(cmd, args, opts);
  };
  const out = await implementNote({ note, spec, runId: "prompt-location", parent, base: parent, baseImage: "base", cfg, runner, reviewFn: pass });
  assert.equal(out.ok, true);
  assert.ok(promptFile.startsWith(`${tmpdir()}/`), "dispatch prompt must live under os.tmpdir()");
  assert.equal(promptFile.startsWith(`${cfg.workDir}/`), false, "dispatch prompt must not live under cfg.workDir");
});

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
