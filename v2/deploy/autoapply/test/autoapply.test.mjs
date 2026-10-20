import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../autoapply.mjs";
import { createJournal } from "../journal.mjs";
import { run } from "../run.mjs";
import { acquire } from "../lock.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const envelope = (result) => ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(result) }));
const spec = { problem: "The brand filter resets", expected: "Remember the brand filter", where: "/items", doneWhen: ["The filter survives a reload"] };
const note = (id) => ({ id, kind: "IDEA", revision: 2, note: "Remember my brand filter", path: "/items", author: "t", status: "OPEN", autoState: null, autoClaim: null, createdAt: `2026-10-15T00:00:0${id}Z` });
const DISABLE = "systemctl --user disable --now profitindex-autoapply.timer";

function harness(t) {
  const tmp = mkdtempSync(join(tmpdir(), "autoapply-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const origin = join(tmp, "origin.git");
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, repo], { stdio: "pipe" });
  mkdirSync(join(repo, "v2/apps/api/test"), { recursive: true });
  writeFileSync(join(repo, "v2/apps/api/a.ts"), "1\n");
  writeFileSync(join(repo, "v2/apps/api/test/.keep"), "");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "push", "--quiet", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  const cfg = {
    repo, branch: "main", api: "http://app", token: "test-token",
    stateDir: join(tmp, "state"), workDir: join(tmp, "work"),
    receiptsDir: join(tmp, "receipts"), deployLock: join(tmp, "deploy.lock"),
    haltFile: join(tmp, "state/HALT"), vaultLogDir: join(tmp, "vault-logs"),
    authors: ["t"], maxPerRun: 5, notifyUrl: "http://ntfy", dryRun: false,
    timeouts: { model: 5000, codex: 5000, gate: 5000, migration: 5000, deploy: 5000 },
  };
  mkdirSync(join(cfg.receiptsDir, "backups"), { recursive: true });
  writeFileSync(join(cfg.receiptsDir, "backups/base.dump"), "fake backup\n");
  const journal = createJournal(cfg.stateDir);
  const rows = () => existsSync(join(cfg.stateDir, "runs.jsonl"))
    ? readFileSync(join(cfg.stateDir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const state = {
    notes: [], lists: [], posts: [], alerts: [], calls: [], releaseRows: [],
    quota: 38, triage: { clear: true, spec }, failDispatch: new Set(),
    crashOnModel: false, crash: new Error("simulated process death after claim"),
    migrate: false,
  };
  const originTip = () => git(origin, "rev-parse", "refs/heads/main");
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const parsed = new URL(url);
    if (parsed.origin === cfg.notifyUrl && method === "POST") {
      state.alerts.push({ title: init.headers?.Title, body: String(init.body) });
      return json({});
    }
    if (parsed.origin !== cfg.api) throw new Error(`Unexpected fetch: ${method} ${url}`);
    // Simulate a healthy deployer following the actual local origin, including after push.
    if (method === "GET" && parsed.pathname === "/api/health") return json({ ok: true, build: state.build ?? originTip().slice(0, 7) });
    if (method === "GET" && parsed.pathname === "/api/books/check") return json({ sound: true });
    if (method === "GET" && parsed.pathname + parsed.search === "/api/feedback?turns=1") return json(state.lists.length ? state.lists.shift() : state.notes);
    const action = parsed.pathname.match(/^\/api\/feedback\/(\d+)\/auto\/(claim|outcome|question|release)$/);
    if (method === "POST" && action) {
      const id = Number(action[1]);
      const body = JSON.parse(init.body);
      state.posts.push({ id, action: action[2], body });
      if (action[2] === "release") state.releaseRows.push(rows());
      const status = state.postStatus?.(id, action[2]) ?? 200;
      if (status === 200) {
        const n = state.notes.find((n) => n.id === id);
        if (n && action[2] === "claim") { n.autoClaim = body.runId; n.autoRevision = body.revision; }
        if (n && ["release", "question", "outcome"].includes(action[2])) n.autoClaim = null;
      }
      return json({ id }, status);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  const runner = async (cmd, args, opts) => {
    const key = [cmd, ...args].join(" ");
    state.calls.push(key);
    if (key.includes("statusline_agents")) return ok(JSON.stringify({ primary: { used_percent: state.quota }, secondary: { used_percent: 40 } }));
    if (key.includes("docker inspect profitindex-app-1")) return ok("sha256:live\n");
    if (key.includes("docker image inspect")) return ok(`NODE_ENV=production\nAPP_VERSION=${originTip().slice(0, 7)}\n`);
    if (cmd === "claude") {
      if (state.crashOnModel) throw state.crash;
      return envelope(args[1].includes("<diff>") ? { pass: true, reasons: "Matches the request" } : state.triage);
    }
    if (cmd === "dispatch") {
      const wt = args.find((a) => a.startsWith("--cd=")).slice(5);
      const id = Number(wt.match(/note-(\d+)$/)[1]);
      if (state.failDispatch.has(id)) return { code: 1, stdout: "", stderr: "implementation refused" };
      writeFileSync(join(wt, "v2/apps/api/a.ts"), `filter remembered for #${id}\n`);
      writeFileSync(join(wt, `v2/apps/api/test/note-${id}.test.ts`), "filter survives reload\n");
      if (state.migrate) {
        const migration = join(wt, `v2/apps/api/prisma/migrations/note_${id}`);
        mkdirSync(migration, { recursive: true });
        writeFileSync(join(migration, "migration.sql"), "ALTER TABLE filters ADD remembered boolean;\n");
      }
      return ok("status:  answered\n");
    }
    if (cmd === "sh" && (args[0].endsWith("/gate.sh") || args[0].endsWith("/migration-gate.sh"))) return ok();
    if (cmd === "systemctl") return ok();
    if (cmd === "git") {
      assert.ok(args[0] === "-C" && args[1].startsWith(`${tmp}/`), "git only touches the temporary fixture");
      return run(cmd, args, opts);
    }
    throw new Error(`Unexpected runner call: ${key}`);
  };
  const sleep = async () => {};
  const now = () => new Date("2026-10-16T07:00:00Z");
  const seedFailures = (n) => {
    for (let i = 0; i < n; i++) {
      journal.start(`previous-${i}`);
      journal.finish(`previous-${i}`, "FAILED", "previous failure");
    }
  };
  return { cfg, state, journal, rows, originTip, base, seedFailures, args: { cfg, runner, fetchImpl, sleep, now } };
}

test("nothing to do: NOTHING leaves the failure streak unchanged", async (t) => {
  const h = harness(t);
  h.seedFailures(2);
  const result = await main(h.args);
  assert.equal(result.outcome, "NOTHING");
  for (const key of ["shipped", "failed", "waiting", "deferred"]) assert.deepEqual(result[key], []);
  assert.equal(h.journal.failureStreak(), 2);
  assert.equal(h.rows().at(-1).outcome, "NOTHING");
  assert.deepEqual(h.state.posts, []);
  assert.ok(!h.state.calls.some((c) => /^(dispatch|claude|systemctl) /.test(c)));
  assert.equal(h.originTip(), h.base);
});

test("unclear note gets a question with the triage text and no dispatch", async (t) => {
  const h = harness(t);
  h.state.notes = [note(1)];
  h.state.triage = { clear: false, question: "Which filter should survive a reload?" };
  const result = await main(h.args);
  assert.deepEqual(result.waiting, [1]);
  assert.deepEqual(result.shipped, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(h.state.posts, [
    { id: 1, action: "claim", body: { runId: result.runId, revision: 2 } },
    { id: 1, action: "question", body: { runId: result.runId, revision: 2, text: "Which filter should survive a reload?" } },
  ]);
  assert.ok(!h.state.calls.some((c) => c.startsWith("dispatch ")));
  assert.equal(h.originTip(), h.base);
});

test("one ships, one fails: SHIPPED reports both and the FAILED outcome carries the reason", { timeout: 15_000 }, async (t) => {
  const h = harness(t);
  h.state.notes = [note(1), note(2)];
  h.state.failDispatch.add(2);
  h.state.migrate = true;
  const result = await main(h.args);
  assert.equal(result.outcome, "SHIPPED");
  assert.deepEqual(result.shipped, [1]);
  assert.deepEqual(result.failed, [{ id: 2, reason: "codex: implementation refused" }]);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(result.deferred, []);
  const candidate = h.originTip();
  assert.notEqual(candidate, h.base);
  assert.equal(git(h.cfg.repo, "show", `${candidate}:v2/apps/api/a.ts`), "filter remembered for #1");
  assert.match(git(h.cfg.repo, "log", "-1", "--format=%B", candidate), /Feedback-Revision: 1@2/);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "outcome"), [
    { id: 2, action: "outcome", body: { runId: result.runId, revision: 2, autoState: "FAILED", autoNote: "codex: implementation refused" } },
    { id: 1, action: "outcome", body: { runId: result.runId, revision: 2, autoState: "SHIPPED", autoCommit: candidate, status: "DONE" } },
  ]);
  assert.ok(h.state.calls.some((c) => c.startsWith("sh ") && c.includes("/gate.sh")));
  assert.ok(h.state.calls.some((c) => c.includes("/migration-gate.sh") && c.includes("sha256:live")));
  const report = h.state.alerts.find((a) => /: SHIPPED$/.test(a.title));
  assert.ok(report, "a SHIPPED report is sent");
  assert.match(report.body, /shipped #1/);
  assert.match(report.body, /failed #2 \(codex: implementation refused\)/);
  const logs = readdirSync(h.cfg.vaultLogDir).filter((f) => f.endsWith("-profitindex-autoapply.md"));
  assert.equal(logs.length, 1);
  const log = readFileSync(join(h.cfg.vaultLogDir, logs[0]), "utf8");
  assert.ok(log.includes(result.runId));
  assert.match(log, /shipped #1/);
  assert.match(log, /failed #2 \(codex: implementation refused\)/);
  assert.equal(h.journal.failureStreak(), 0);
});

test("stop rule at 6: failed preflight writes HALT *, disables the timer and alerts", async (t) => {
  const h = harness(t);
  h.seedFailures(5);
  h.state.build = "0000000";   // a real failure: the live app is not the deploy tip (quota is now a fallback, not a failure)
  const result = await main(h.args);
  assert.equal(result.outcome, "FAILED");
  assert.match(result.failed[0].reason, /not the deploy tip/);
  assert.equal(h.journal.failureStreak(), 6);
  assert.equal(readFileSync(h.cfg.haltFile, "utf8").trim(), "*");
  assert.ok(h.state.calls.includes(DISABLE));
  const alert = h.state.alerts.find((a) => a.title === "Auto-apply STOPPED");
  assert.ok(alert, "the stop alert is sent");
  assert.match(alert.body, /six failed runs/i);
  assert.match(alert.body, /disabled itself/i);
  assert.deepEqual(h.state.posts, []);
});

test("warning at 4: alerts without HALT or disabling the timer", async (t) => {
  const h = harness(t);
  h.seedFailures(3);
  h.state.build = "0000000";   // a real failure: the live app is not the deploy tip (quota is now a fallback, not a failure)
  const result = await main(h.args);
  assert.equal(result.outcome, "FAILED");
  assert.equal(h.journal.failureStreak(), 4);
  assert.equal(existsSync(h.cfg.haltFile), false);
  assert.ok(!h.state.calls.some((c) => c.startsWith("systemctl ")));
  const alert = h.state.alerts.find((a) => a.title === "Auto-apply warning");
  assert.ok(alert, "the warning is sent");
  assert.match(alert.body, /4 failed runs/);
  assert.match(alert.body, /[Aa]t 6/);
  assert.deepEqual(h.state.posts, []);
});

test("crash then restart: recovery releases the claim and journals FAILED before the next STARTED", async (t) => {
  const h = harness(t);
  h.state.notes = [note(1)];
  h.state.crashOnModel = true;
  await assert.doesNotReject(() => main(h.args), "main contains the crash after claiming");
  const alert = h.state.alerts.find((a) => a.title === "Auto-apply crashed");
  assert.ok(alert, "the contained crash sends an alert");
  assert.ok(alert.body.includes(h.state.crash.message), "the alert identifies the crash");
  assert.equal(h.state.posts.length, 1);
  const claim = h.state.posts[0];
  assert.equal(claim.action, "claim");
  const firstRunId = claim.body.runId;
  assert.deepEqual(h.journal.unfinished(), [firstRunId]);
  assert.ok(h.journal.readNotes(firstRunId).some((e) => e.id === 1 && e.revision === 2 && e.event === "claimed"));
  assert.equal(h.rows().some((r) => r.phase === "FINISHED"), false);
  h.state.crashOnModel = false;
  h.state.lists = [[{ ...note(1), autoClaim: firstRunId, autoRevision: 2 }], []];
  const second = await main({ ...h.args, now: () => new Date("2026-10-17T07:00:00Z") });
  assert.notEqual(second.runId, firstRunId);
  assert.equal(second.outcome, "NOTHING");
  assert.deepEqual(h.state.posts, [claim, { id: 1, action: "release", body: { runId: firstRunId, revision: 2 } }]);
  const rows = h.rows();
  const recovered = rows.findIndex((r) => r.runId === firstRunId && r.phase === "FINISHED");
  const started = rows.findIndex((r) => r.runId === second.runId && r.phase === "STARTED");
  assert.ok(recovered >= 0 && started > recovered, "recovery finishes before the new run starts");
  assert.equal(rows[recovered].outcome, "FAILED");
  assert.match(rows[recovered].detail, /recover/i);
  assert.equal(h.state.releaseRows.length, 1);
  assert.ok(!h.state.releaseRows[0].some((r) => r.runId === second.runId), "the claim is released before the new run starts");
  assert.deepEqual(h.journal.unfinished(), []);
  assert.equal(h.journal.failureStreak(), 1);
  assert.ok(!h.state.calls.some((c) => c.startsWith("dispatch ")));
  assert.equal(h.originTip(), h.base);
});

test("F2: a busy deploy lock leaves main PENDING and the first run recoverable", { timeout: 15_000 }, async (t) => {
  const h = harness(t);
  h.state.notes = [note(1)];
  h.cfg.timeouts.deploy = 20;
  let release = await acquire(h.cfg.deployLock);
  assert.ok(release);
  t.after(async () => { if (release) await release(); });
  const first = await main(h.args);
  const unfinished = h.journal.unfinished();
  const firstRows = h.rows();
  const manifest = h.journal.readManifest(first.runId);
  assert.ok(manifest?.candidate, "ship prepared a candidate while the deploy lock was busy");
  assert.equal(h.originTip(), h.base, "the busy lock prevented the candidate push");
  await release();
  release = null;
  // Simulate the queued release reaching origin and the live app before restart.
  git(h.cfg.repo, "push", "--quiet", "origin", `${manifest.candidate}:refs/heads/main`);
  h.state.build = manifest.candidate.slice(0, 7);
  h.state.lists = [[{ ...note(1), autoClaim: first.runId, autoRevision: 2 }], []];
  await main({ ...h.args, now: () => new Date("2026-10-17T07:00:00Z") });
  assert.equal(first.outcome, "PENDING", "a busy deploy lock must remain PENDING");
  assert.ok(unfinished.includes(first.runId), "PENDING runs must remain unfinished");
  assert.equal(firstRows.some((r) => r.runId === first.runId && r.phase === "FINISHED"), false);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "outcome"), [
    { id: 1, action: "outcome", body: { runId: first.runId, revision: 2, autoState: "SHIPPED", autoCommit: manifest.candidate, status: "DONE" } },
  ]);
  assert.equal(h.journal.readManifest(first.runId).phase, "DONE");
});

test("F3: rejected outcome and question writes release their claims", async (t) => {
  await t.test("outcome 409 after implement failure releases the note", async (t) => {
    const h = harness(t);
    h.state.notes = [note(1)];
    h.state.failDispatch.add(1);
    h.state.postStatus = (_id, action) => action === "outcome" ? 409 : 200;
    const result = await main(h.args);
    assert.deepEqual(h.state.posts.map((p) => p.action), ["claim", "outcome", "release"], "failed outcome POST must be followed by release POST");
    assert.deepEqual(h.state.posts.at(-1), { id: 1, action: "release", body: { runId: result.runId, revision: 2 } });
  });
  await t.test("question 500 releases the note without reporting it waiting", async (t) => {
    const h = harness(t);
    h.state.notes = [note(1)];
    h.state.triage = { clear: false, question: "Which filter?" };
    h.state.postStatus = (_id, action) => action === "question" ? 500 : 200;
    const result = await main(h.args);
    assert.deepEqual(h.state.posts.map((p) => p.action), ["claim", "question", "release"], "failed question POST must be followed by release POST");
    assert.deepEqual(h.state.posts.at(-1), { id: 1, action: "release", body: { runId: result.runId, revision: 2 } });
    assert.deepEqual(result.waiting, [], "an undelivered question is not waiting on the tester");
  });
});

test("F8: main contains implement and recovery crashes and alerts", async (t) => {
  await t.test("implement runner throws: resolve, alert and leave the run unfinished", async (t) => {
    const h = harness(t);
    h.state.notes = [note(1)];
    const runner = (cmd, args, opts) => {
      if (cmd === "dispatch") throw new Error("simulated implement runner crash");
      return h.args.runner(cmd, args, opts);
    };
    await assert.doesNotReject(() => main({ ...h.args, runner }), "main must contain implement runner exceptions");
    const runId = h.state.posts.find((p) => p.action === "claim").body.runId;
    assert.ok(h.state.alerts.some((a) => a.title === "Auto-apply crashed"), "implementation crash must alert");
    assert.ok(h.journal.unfinished().includes(runId), "crashed run must remain recoverable");
    assert.equal(h.rows().some((r) => r.runId === runId && r.phase === "FINISHED"), false);
  });
  await t.test("corrupt recovery manifest: journal a FINISHED FAILED run and alert", async (t) => {
    const h = harness(t);
    h.journal.start("interrupted");
    writeFileSync(join(h.cfg.stateDir, "release-interrupted.json"), "{corrupt manifest");
    await assert.doesNotReject(() => main(h.args), "main must contain recovery exceptions");
    const finished = h.rows().find((r) => r.phase === "FINISHED" && r.outcome === "FAILED" && /recovery failed/i.test(r.detail));
    assert.ok(finished, "recovery failed must be journaled as FINISHED FAILED");
    assert.equal(h.journal.failureStreak(), 1);
    assert.ok(h.state.alerts.length > 0, "recovery failure must alert");
    assert.ok(!h.state.calls.some((c) => c.startsWith("dispatch ")), "recovery failure must prevent new implementations");
  });
});

test("F9: ship NOTHING after every accepted note is edited leaves the failure streak unchanged", { timeout: 15_000 }, async (t) => {
  const h = harness(t);
  h.seedFailures(2);
  h.state.notes = [note(1)];
  h.state.lists = [[note(1)], [{ ...note(1), revision: 3 }]];
  const result = await main(h.args);
  assert.ok(h.state.calls.some((c) => c.startsWith("dispatch ")), "the note was implemented before it was edited");
  assert.ok(h.journal.readNotes(result.runId).some((e) => e.event === "accepted"));
  assert.equal(h.originTip(), h.base);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "release"), [
    { id: 1, action: "release", body: { runId: result.runId, revision: 2 } },
  ]);
  assert.equal(result.outcome, "NOTHING", "editing all accepted notes is a neutral run");
  assert.equal(h.journal.failureStreak(), 2);
  assert.equal(h.rows().at(-1).outcome, "NOTHING");
});

test("GPU busy is a neutral skip, not a failed run", async () => {
  const { main } = await import("../autoapply.mjs");
  const { createJournal } = await import("../journal.mjs");
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "gpu-busy-"));
  const cfg = { repo: tmp, branch: "main", api: "http://app", stateDir: join(tmp, "state"), workDir: join(tmp, "work"), deployLock: join(tmp, "lock"), receiptsDir: join(tmp, "rc"), haltFile: join(tmp, "state/HALT"), authors: ["t"], maxPerRun: 3, token: "x", notifyUrl: "", vaultLogDir: join(tmp, "vault"), dryRun: false, implLane: "local", timeouts: { model: 1000, codex: 1000, gate: 1000, migration: 1000, deploy: 1000 } };
  const runner = async (cmd, args) => {
    if (cmd === "local-llm") return { code: 0, stdout: "mode: q36-cpu  unit: active\nhealth: ok\n", stderr: "" };
    if (cmd === "git" && args.includes("rev-parse")) return { code: 0, stdout: "a3f40a8d0000000000000000000000000000000\n", stderr: "" };
    if (cmd === "docker" && args[0] === "inspect") return { code: 0, stdout: "sha256:live\n", stderr: "" };
    if (cmd === "docker") return { code: 0, stdout: "APP_VERSION=a3f40a8\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchImpl = async (url) => new Response(url.includes("/api/health") ? '{"ok":true,"build":"a3f40a8"}' : "[]");
  const r = await main({ cfg, runner, fetchImpl, sleep: async () => {} });
  assert.equal(r.outcome, "NOTHING");
  assert.equal(createJournal(cfg.stateDir).failureStreak(), 0);
});

