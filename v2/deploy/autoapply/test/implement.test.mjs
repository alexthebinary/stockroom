import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
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
const fake = (edit, { gate = 0, gateStdout = "tests: 1 failed", gateStderr = "", prompts = [], commands = [], migration = 0, implementation = { code: 0, stdout: "status:  answered\n", stderr: "" } } = {}) => {
  let gateIndex = 0;
  return async (cmd, args, opts) => {
    calls.push([cmd, ...args].join(" "));
    commands.push([cmd, ...args]);
    if (cmd === "dispatch" || cmd === "codex") {
      const wt = cmd === "dispatch" ? args.find((a) => a.startsWith("--cd=")).slice(5) : args[args.indexOf("-C") + 1];
      prompts.push(cmd === "codex" ? opts.input : readFileSync(args.at(-1), "utf8"));
      edit(wt, prompts.length);
      return implementation;
    }
    if (cmd === "sh" && args[0].endsWith("migration-gate.sh")) return { code: migration, stdout: "", stderr: "base image: GET /api/items 500" };
    if (cmd === "sh" && args[0].endsWith("/gate.sh")) {
      const code = Array.isArray(gate) ? gate[gateIndex++] : gate;
      assert.notEqual(code, undefined, "gate ran more times than its scripted sequence");
      return { code, stdout: code === 0 ? "tests passed" : gateStdout, stderr: code === 0 ? "" : gateStderr };
    }
    return run(cmd, args, opts);
  };
};
const note = { id: 9, kind: "IDEA", revision: 4, note: "n" };
const spec = { problem: "p", expected: "Remember the brand filter", where: "/items", doneWhen: ["d"] };
const pass = async () => ({ pass: true, reasons: "ok" });
const withTest = (wt) => { writeFileSync(join(wt, "v2/apps/api/a.ts"), "2\n"); writeFileSync(join(wt, "v2/apps/api/test/a.test.ts"), "t\n"); };

for (const lane of ["local", "codex"]) {
  test(`${lane}: gate failure is fed back and retried`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [], commands = [];
    const out = await implementNote({ note, spec, runId: "retry-gate", parent, base: parent, baseImage: "base", cfg,
      runner: fake(withTest, { gate: [1, 0], gateStdout: "FAIL items count expected 3 got 1", prompts, commands }), reviewFn: pass });
    assert.equal(out.ok, true, out.reason);
    assert.equal(prompts.length, 2, "implementer must retry once");
    assert.ok(prompts[1].includes("FAIL items count expected 3 got 1"), "retry must include the gate failure");
    assert.match(prompts[1], /Done when/i);
    assert.doesNotMatch(prompts[1], /screen with no test harness|test[^\n.]*not possible|precise code change/i);
    assert.match(prompts[1], /every change[^\n.]*test/i);
    assert.match(prompts[1], /v2\/apps\/api\/test/);
    assert.match(prompts[1], /react-dom\/server/);
    assert.match(prompts[1], /renderToStaticMarkup/);
    assert.match(prompts[1], /QueryClient/);
    assert.equal(commands.filter(([cmd, script]) => cmd === "sh" && script.endsWith("/gate.sh")).length, 2);
    assert.equal(commands.filter(([cmd, ...args]) => cmd === "git" && args.includes("commit")).length, 1);
    assert.equal(git(r, "rev-list", "--count", `${parent}..${out.sha}`), "1");
  });

  test(`${lane}: retry preserves early diagnostics before the final 40 output lines`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [];
    const diagnostics = [
      "apps/api/src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "FAIL items count expected 3 got 1", "✗ brand filter", "× saved brand", "ts1234 diagnostic", "ERROR build stopped",
    ];
    const passing = Array.from({ length: 85 }, (_, i) => `passing test ${i + 1}`);
    const out = await implementNote({ note, spec, runId: "early-diagnostics", parent, base: parent, baseImage: "base", cfg,
      runner: fake(withTest, { gate: [1, 0], gateStdout: [...diagnostics, ...passing].join("\n"), prompts }), reviewFn: pass });
    assert.equal(out.ok, true, out.reason);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /TS2322/);
    assert.ok(prompts[1].includes("x.ts(3,7)"));
    for (const diagnostic of diagnostics) assert.ok(prompts[1].includes(diagnostic), `missing diagnostic: ${diagnostic}`);
    assert.ok(prompts[1].includes(passing.slice(-40).join("\n")), "retry must include the final 40 lines in order");
    assert.equal(prompts[1].includes("passing test 45\n"), false, "passing output before the tail must be omitted");
    assert.ok(prompts[1].indexOf(diagnostics[0]) < prompts[1].indexOf("passing test 46\n"));
  });

  test(`${lane}: gives up after two retries`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    assert.equal(cfg.retries, undefined, "exercise the default retry budget");
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [], commands = [];
    const out = await implementNote({ note, spec, runId: "retry-exhausted", parent, base: parent, baseImage: "base", cfg,
      runner: fake(withTest, { gate: [1, 1, 1], prompts, commands }), reviewFn: pass });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^tests failed/);
    assert.equal(commands.filter(([cmd, ...args]) => cmd === "git" && args.includes("commit")).length, 0);
    assert.equal(existsSync(join(cfg.workDir, "retry-exhausted", "note-9")), false);
    assert.equal(prompts.length, 3, "undefined retries must allow the initial attempt and two retries");
    assert.equal(commands.filter(([cmd, script]) => cmd === "sh" && script.endsWith("/gate.sh")).length, 3);
  });

  test(`${lane}: no test changed is retried too`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [], commands = [];
    const edit = (wt, attempt) => {
      writeFileSync(join(wt, "v2/apps/api/a.ts"), "2\n");
      if (attempt === 2) withTest(wt);
    };
    const out = await implementNote({ note, spec, runId: "retry-missing-test", parent, base: parent, baseImage: "base", cfg,
      runner: fake(edit, { gate: [0], prompts, commands }), reviewFn: pass });
    assert.equal(out.ok, true, out.reason);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /(?:\btest\b[^\n.]*\b(?:required|must|needed)\b|\b(?:require[ds]?|must|need(?:s|ed)?)\b[^\n.]*\btest\b)/i,
      "retry must say that a test is required");
    assert.equal(commands.filter(([cmd, script]) => cmd === "sh" && script.endsWith("/gate.sh")).length, 1);
    assert.equal(git(r, "show", `${out.sha}:v2/apps/api/test/a.test.ts`), "t");
  });

  test(`${lane}: cfg.retries = 0 disables retries`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    cfg.retries = 0;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [], commands = [];
    const out = await implementNote({ note, spec, runId: "no-retry", parent, base: parent, baseImage: "base", cfg,
      runner: fake(withTest, { gate: [1, 0], prompts, commands }), reviewFn: pass });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^tests failed/);
    assert.equal(prompts.length, 1);
    assert.equal(commands.filter(([cmd, ...args]) => cmd === "git" && args.includes("commit")).length, 0);
    assert.equal(existsSync(join(cfg.workDir, "no-retry", "note-9")), false);
  });
}

test("retry caps selected diagnostics at 80 lines and keeps the output tail", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  const parent = git(r, "rev-parse", "HEAD");
  const prompts = [];
  const diagnostics = Array.from({ length: 81 }, (_, i) => `FAIL diagnostic ${i + 1}`);
  const tail = Array.from({ length: 40 }, (_, i) => `output tail ${i + 1}`);
  const out = await implementNote({ note, spec, runId: "diagnostic-cap", parent, base: parent, baseImage: "base", cfg,
    runner: fake(withTest, { gate: [1, 0], gateStdout: diagnostics.join("\n"), gateStderr: tail.join("\n"), prompts }), reviewFn: pass });
  assert.equal(out.ok, true, out.reason);
  assert.equal(prompts.length, 2);
  for (const diagnostic of diagnostics.slice(0, 80)) assert.ok(prompts[1].includes(`${diagnostic}\n`), `missing diagnostic: ${diagnostic}`);
  assert.equal(prompts[1].includes("FAIL diagnostic 81"), false);
  assert.ok(prompts[1].includes(tail.join("\n")), "stderr tail must be kept after stdout diagnostics");
});

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
  assert.match(provider, /stream_idle_timeout_ms\s*=\s*900000/, "the local model can be silent for minutes on a long context (run 2, 2026-10-19)");
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

for (const lane of ["local", "codex"]) {
  test(`${lane}: a failed review is fed back and retried (supervised run 2026-10-19)`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [];
    let reviews = 0;
    const reviewFn = async () => (++reviews === 1 ? { pass: false, reasons: "No test in the diff renders Items.tsx; the Done when lines are untested." } : { pass: true, reasons: "ok" });
    const out = await implementNote({ note, spec, runId: "retry-review", parent, base: parent, baseImage: "base", cfg,
      runner: fake(withTest, { gate: [0, 0], prompts }), reviewFn });
    assert.equal(out.ok, true, out.reason);
    assert.equal(reviews, 2);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes("No test in the diff renders Items.tsx"), "the reviewer's reason goes back to the implementer");
  });

  test(`${lane}: the first prompt already explains how to test a screen`, async (t) => {
    const { r, cfg } = repo();
    t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
    cfg.implLane = lane;
    const parent = git(r, "rev-parse", "HEAD");
    const prompts = [];
    await implementNote({ note, spec, runId: "first-prompt", parent, base: parent, baseImage: "base", cfg, runner: fake(withTest, { prompts }), reviewFn: pass });
    assert.match(prompts[0], /renderToStaticMarkup/);
    assert.match(prompts[0], /Done when/i);
  });
}

// claude lane: headless Claude edits files only, with no hooks; lane errors retry once, then fall back to the local model.
const claudeRunner = (script, seen, opts = {}) => {
  const base = fake(withTest, opts);
  let n = 0;
  return async (cmd, args, opts) => {
    if (cmd === "claude") {
      seen.push({ args, cwd: opts.cwd });
      const step = script[n++];
      if (step.edit) step.edit(opts.cwd);
      return step.res;
    }
    return base(cmd, args, opts);
  };
};
const okJson = { code: 0, stdout: JSON.stringify({ is_error: false, result: "done" }), stderr: "" };
const busyJson = { code: 1, stdout: JSON.stringify({ is_error: true, result: "We\u2019re currently experiencing high demand" }), stderr: "" };

test("claude lane: runs in the worktree with hooks off and file tools only", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "claude";
  const parent = git(r, "rev-parse", "HEAD");
  const seen = [];
  const out = await implementNote({ note, spec, runId: "claude-ok", parent, base: parent, baseImage: "base", cfg,
    runner: claudeRunner([{ edit: withTest, res: okJson }], seen), reviewFn: pass });
  assert.equal(out.ok, true, out.reason);
  assert.equal(seen.length, 1);
  assert.match(seen[0].cwd, /note-9$/);
  assert.ok(seen[0].args.includes("--strict-mcp-config"));
  assert.ok(JSON.parse(seen[0].args[seen[0].args.indexOf("--settings") + 1]).disableAllHooks);
  assert.deepEqual(seen[0].args.slice(seen[0].args.indexOf("--allowedTools") + 1), ["Read", "Edit", "Write", "Grep", "Glob"]);
});

test("claude lane: a 'high demand' error is retried once", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "claude"; cfg.retryDelayMs = 1;
  const parent = git(r, "rev-parse", "HEAD");
  const seen = [];
  const out = await implementNote({ note, spec, runId: "claude-retry", parent, base: parent, baseImage: "base", cfg,
    runner: claudeRunner([{ res: busyJson }, { edit: withTest, res: okJson }], seen), reviewFn: pass });
  assert.equal(out.ok, true, out.reason);
  assert.equal(seen.length, 2);
});

test("claude lane: a persistent error falls back to the local model", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "claude"; cfg.retryDelayMs = 1;
  const parent = git(r, "rev-parse", "HEAD");
  const commands = [];
  const out = await implementNote({ note, spec, runId: "claude-fallback", parent, base: parent, baseImage: "base", cfg,
    runner: claudeRunner([{ res: busyJson }, { res: busyJson }], [], { commands }), reviewFn: pass });
  assert.equal(out.ok, true, out.reason);
  assert.ok(commands.some((c) => c[0] === "codex" && c.join(" ").includes("model_provider=localllm")), "the local model must run after Claude fails twice");
});

test("claude lane: when the local fallback also fails, the reason names both", async (t) => {
  const { r, cfg } = repo();
  t.after(() => rmSync(join(r, ".."), { recursive: true, force: true }));
  cfg.implLane = "claude"; cfg.retryDelayMs = 1;
  const parent = git(r, "rev-parse", "HEAD");
  const out = await implementNote({ note, spec, runId: "claude-both", parent, base: parent, baseImage: "base", cfg,
    runner: claudeRunner([{ res: busyJson }, { res: busyJson }], [], { implementation: { code: 1, stdout: "", stderr: "ERROR: no model" } }), reviewFn: pass });
  assert.equal(out.ok, false);
  assert.match(out.reason, /^claude: .*high demand.*; local model: ERROR: no model/);
});
