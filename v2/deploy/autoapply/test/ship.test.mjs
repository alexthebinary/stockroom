import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ship, resolveStuck, complete } from "../ship.mjs";
import { recover } from "../recover.mjs";
import { createJournal } from "../journal.mjs";
import { acquire } from "../lock.mjs";
import { createFeedback } from "../feedback.mjs";
import { run } from "../run.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const short = (sha) => sha.slice(0, 7);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function harness(t) {
  const tmp = mkdtempSync(join(tmpdir(), "ship-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const origin = join(tmp, "origin.git");
  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, repo], { stdio: "pipe" });
  const commit = (name) => {
    writeFileSync(join(repo, name), `${name}\n`);
    git(repo, "add", "--", name);
    git(repo, "commit", "-qm", name);
    return git(repo, "rev-parse", "HEAD");
  };
  const base = commit("base");
  git(repo, "push", "--quiet", "origin", "main");
  const accepted = [
    { note: { id: 1, revision: 2 }, sha: commit("first"), migration: false },
    { note: { id: 2, revision: 5 }, sha: commit("second"), migration: false },
  ];
  const candidate = accepted[1].sha;
  const runId = "run-ship";
  const journal = createJournal(tmp);
  const cfg = {
    repo, branch: "main", api: "http://app", deployLock: join(tmp, "lock"),
    receiptsDir: join(tmp, "rc"), workDir: join(tmp, "work"),
    timeouts: { deploy: 30 }, notifyUrl: "http://ntfy",
  };
  mkdirSync(cfg.receiptsDir);
  mkdirSync(cfg.workDir);
  const state = {
    build: short(base), sound: true,
    notes: accepted.map(({ note }) => ({ ...note })),
    posts: [], alerts: [], dispatches: [], outcomeStatuses: [], elapsed: 0,
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const parsed = new URL(url);
    if (parsed.origin === cfg.notifyUrl && method === "POST") {
      state.alerts.push({ title: init.headers?.Title, body: String(init.body) });
      return json({});
    }
    if (parsed.origin !== cfg.api) throw new Error(`Unexpected fetch: ${method} ${url}`);
    if (method === "GET" && parsed.pathname === "/api/health") {
      await state.onHealth?.();
      return json({ ok: true, build: state.build });
    }
    if (method === "GET" && parsed.pathname === "/api/books/check") return json({ sound: state.sound });
    if (method === "GET" && parsed.pathname + parsed.search === "/api/feedback?turns=1") return json(state.onList?.() ?? state.notes);
    const job = parsed.pathname.match(/^\/api\/feedback\/(\d+)\/auto\/(claim|outcome|release|question)$/);
    if (method === "POST" && job) {
      const [, id, action] = job;
      const body = JSON.parse(init.body);
      state.posts.push({ id: Number(id), action, body });
      const status = action === "outcome" ? state.outcomeStatuses.shift() ?? 200 : 200;
      return json(status === 409 ? { error: "edited meanwhile" } : {}, status);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  const feedback = createFeedback({ api: cfg.api, token: "test-token", fetchImpl });
  const epoch = Date.now();
  const originalNow = Date.now;
  Date.now = () => epoch + state.elapsed;
  t.after(() => { Date.now = originalNow; });
  const sleep = async (ms) => {
    // Compress polling intervals so the 30 ms fixture gets intermediate observations.
    state.elapsed += Math.min(ms, 10);
    await state.onSleep?.();
  };
  const runner = (cmd, args, opts) => {
    if (cmd === "dispatch") {
      state.dispatches.push({ cmd, args });
      throw new Error("Recovery must not dispatch new work");
    }
    return run(cmd, args, opts);
  };
  const originTip = () => git(origin, "rev-parse", "refs/heads/main");
  const pushCandidate = () => git(repo, "push", "--quiet", "origin", `${candidate}:refs/heads/main`);
  const manifest = (phase = "AWAITING_DEPLOY") => ({
    runId, base, candidate, migration: accepted.some((a) => a.migration), phase,
    notes: accepted.map(({ note, sha }) => ({
      id: note.id, revision: note.revision, sha,
      payload: { runId, revision: note.revision, autoState: "SHIPPED", autoCommit: sha, status: "DONE" },
    })),
  });
  const args = { runId, base, accepted, cfg, journal, feedback, runner, fetchImpl, sleep };
  return { tmp, repo, base, candidate, runId, accepted, cfg, journal, state, args, commit, originTip, pushCandidate, manifest };
}

function assertShipped(h) {
  assert.deepEqual(h.state.posts.filter((p) => p.action === "outcome"), [
    { id: 1, action: "outcome", body: { runId: h.runId, revision: 2, autoState: "SHIPPED", autoCommit: h.accepted[0].sha, status: "DONE" } },
    { id: 2, action: "outcome", body: { runId: h.runId, revision: 5, autoState: "SHIPPED", autoCommit: h.accepted[1].sha, status: "DONE" } },
  ]);
}

function assertReleased(h, notes = h.accepted.map((a) => a.note)) {
  assert.deepEqual(h.state.posts, notes.map(({ id, revision }) => ({
    id, action: "release", body: { runId: h.runId, revision },
  })));
}

function assertFailed(h, reason) {
  const outcomes = h.state.posts.filter((p) => p.action === "outcome");
  assert.equal(outcomes.length, 2);
  for (const [i, post] of outcomes.entries()) {
    assert.equal(post.id, h.accepted[i].note.id);
    assert.equal(post.body.autoState, "FAILED");
    assert.match(post.body.autoNote, reason);
    assert.notEqual(post.body.status, "DONE");
  }
}

test("ships and completes", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.state.onSleep = () => { h.state.build = short(h.originTip()); };
  const result = await ship(h.args);
  assert.equal(result.outcome, "SHIPPED");
  assert.equal(h.originTip(), h.candidate);
  assert.equal(h.state.posts.length, 2);
  assertShipped(h);
  assert.equal(h.journal.readManifest(h.runId).phase, "DONE");
});

test("concurrent push", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  // A separate branch from base advances origin without including our candidates.
  git(h.repo, "checkout", "--quiet", "-b", "other", h.base);
  const other = h.commit("concurrent");
  git(h.repo, "push", "--quiet", "origin", `${other}:refs/heads/main`);
  git(h.repo, "checkout", "--quiet", "main");
  const result = await ship(h.args);
  assert.equal(result.outcome, "RETRY");
  assert.equal(h.originTip(), other);
  assertReleased(h);
});

test("halt set before push", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.journal.halt("*");
  const result = await ship(h.args);
  assert.equal(result.outcome, "HALTED");
  assert.equal(h.originTip(), h.base);
  assertReleased(h);
});

test("slow deploy is not a failure (review finding 1)", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.journal.start(h.runId);
  let release;
  t.after(async () => { if (release) await release(); });
  // The deployer takes the lock after ship has pushed and released it.
  h.state.onHealth = async () => {
    if (!release && h.originTip() === h.candidate) {
      release = await acquire(h.cfg.deployLock);
      assert.ok(release);
    }
  };
  h.state.onSleep = () => {
    if (h.state.elapsed > h.cfg.timeouts.deploy) h.state.build = short(h.candidate);
  };
  const result = await ship(h.args);
  assert.equal(result.outcome, "PENDING");
  assert.equal(h.originTip(), h.candidate);
  assert.equal(existsSync(join(h.tmp, "HALT")), false);
  h.state.onHealth = undefined;
  await release();
  release = null;
  await recover(h.args);
  assertShipped(h);
  assert.equal(h.originTip(), h.candidate);
  assert.equal(existsSync(join(h.tmp, "HALT")), false);
  assert.equal(h.journal.readManifest(h.runId).phase, "DONE");
});

test("unhealthy, no migration", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.state.onSleep = () => {
    const tip = h.originTip();
    if (tip !== h.candidate) h.state.build = short(tip);
  };
  const result = await ship(h.args);
  const reverted = h.originTip();
  assert.equal(result.outcome, "ROLLED_BACK");
  assert.notEqual(reverted, h.candidate);
  assert.equal(git(h.repo, "rev-parse", `${reverted}^{tree}`), git(h.repo, "rev-parse", `${h.base}^{tree}`));
  const messages = git(h.repo, "log", "--format=%B", `${h.candidate}..${reverted}`);
  for (const a of h.accepted) assert.ok(messages.includes(`This reverts commit ${a.sha}.`));
  assertFailed(h, /rolled back/);
  assert.equal(existsSync(join(h.tmp, "HALT")), false);
  assert.equal(h.journal.readManifest(h.runId).phase, "ROLLED_BACK");
});

test("unhealthy with a migration", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.accepted[1].migration = true;
  const backup = join(h.cfg.receiptsDir, "backups", "before-candidate.dump");
  writeFileSync(join(h.cfg.receiptsDir, `receipt-${h.candidate}.json`), JSON.stringify({ sha: h.candidate, backup, sha256: "a".repeat(64) }));
  const result = await ship(h.args);
  assert.equal(result.outcome, "HALTED");
  assert.equal(readFileSync(join(h.tmp, "HALT"), "utf8").trim(), h.candidate);
  assert.equal(h.originTip(), h.candidate);
  assert.ok(h.state.alerts.some((alert) => alert.body.includes(backup)));
  assertFailed(h, /halted/);
  assert.equal(h.journal.readManifest(h.runId).phase, "HALTED");
});

test("a revert of our candidate goes live (review finding 4)", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  let reverted;
  h.state.onSleep = () => {
    if (reverted) return;
    git(h.repo, "revert", "--no-edit", h.candidate);
    reverted = git(h.repo, "rev-parse", "HEAD");
    git(h.repo, "push", "--quiet", "origin", `${reverted}:refs/heads/main`);
    h.state.build = short(reverted);
  };
  await ship(h.args);
  assertFailed(h, /reverted after shipping/);
});

test("recover after push (crash before COMPLETING)", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.pushCandidate();
  h.journal.start(h.runId);
  h.journal.writeManifest(h.manifest());
  h.state.build = short(h.candidate);
  await recover(h.args);
  assert.equal(h.state.posts.length, 2);
  assertShipped(h);
  assert.equal(h.journal.readManifest(h.runId).phase, "DONE");
  const rows = readFileSync(join(h.tmp, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.runId === h.runId && row.phase === "FINISHED" && row.outcome === "FAILED" && row.detail.includes("recovered: AWAITING_DEPLOY")));
  assert.deepEqual(h.state.dispatches, []);
});

function claimedRun(h) {
  h.journal.start(h.runId);
  h.journal.noteEvent(h.runId, { event: "claimed", id: 7, revision: 3 });
  h.state.notes = [{ id: 7, revision: 3, autoClaim: h.runId, autoRevision: 3 }];
}

test("recover with no manifest (crash right after claiming)", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  claimedRun(h);
  await recover(h.args);
  assertReleased(h, [{ id: 7, revision: 3 }]);
});

test("dry-run recover", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  claimedRun(h);
  const result = await recover({ ...h.args, dryRun: true });
  assert.deepEqual(h.state.posts, []);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].runId, h.runId);
  assert.equal(result.recovered[0].phase, "NO_MANIFEST");
  assert.match(result.recovered[0].result, /would.*1 claim/);
});

test("F4: rollback intent is durable before a crashing revert push and recovery recognizes it", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.journal.start(h.runId);
  const crash = new Error("connection lost after remote accepted revert push");
  let beforePush, revert;
  const runner = async (cmd, args, opts) => {
    if (cmd === "git" && args.includes("push") && args[1].endsWith("/revert")) {
      beforePush = h.journal.readManifest(h.runId);
      revert = args.at(-1).split(":")[0];
      const pushed = await h.args.runner(cmd, args, opts);
      assert.equal(pushed.code, 0, "the real local revert push landed before the error");
      assert.equal(h.originTip(), revert);
      throw crash;
    }
    return h.args.runner(cmd, args, opts);
  };
  h.state.onSleep = () => {
    if (revert) h.state.build = short(h.originTip());
  };
  const result = await ship({ ...h.args, runner });
  assert.match(revert, /^[0-9a-f]{40}$/);
  assert.equal(beforePush.phase, "ROLLING_BACK", "persist rollback intent before attempting its push");
  assert.equal(beforePush.revert, revert, "persist the revert SHA before attempting its push");
  assert.equal(h.originTip(), revert);
  assert.equal(h.state.build, short(revert), "the revert is live before resolving");
  assert.equal(result.outcome, "ROLLED_BACK", "ship reconciles a landed revert push despite the error");
  assert.equal(existsSync(join(h.tmp, "HALT")), false);
  assertFailed(h, /rolled back/);
  assert.equal(h.journal.readManifest(h.runId).phase, "ROLLED_BACK");
});

test("F5: feedback edited while waiting for the deploy lock truncates the pushed prefix", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.accepted[1].note.revision = 1;
  let edited = false;
  h.state.onList = () => [{ id: 1, revision: 2 }, { id: 2, revision: edited ? 2 : 1 }];
  let release = await acquire(h.cfg.deployLock);
  assert.ok(release);
  t.after(async () => { if (release) await release(); });
  h.state.onSleep = async () => {
    if (release) {
      edited = true;
      await release();
      release = null;
    }
    h.state.build = short(h.originTip());
  };
  const result = await ship(h.args);
  assert.equal(h.originTip(), h.accepted[0].sha, "only the still-current prefix may be pushed under the deploy lock");
  assert.equal(result.outcome, "SHIPPED");
  assert.deepEqual(result.shipped, [1]);
  assert.deepEqual(result.deferred, [2]);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "release"), [
    { id: 2, action: "release", body: { runId: h.runId, revision: 1 } },
  ]);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "outcome").map((p) => p.id), [1]);
});

test("F6: COMPLETING recovery fails notes when the live release has been reverted", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  h.pushCandidate();
  h.journal.start(h.runId);
  h.journal.writeManifest(h.manifest("COMPLETING"));
  git(h.repo, "revert", "--no-edit", h.candidate);
  const revert = git(h.repo, "rev-parse", "HEAD");
  git(h.repo, "push", "--quiet", "origin", `${revert}:refs/heads/main`);
  h.state.build = short(revert);
  await recover(h.args);
  assertFailed(h, /reverted after shipping/);
  assert.equal(h.state.posts.some((p) => p.body.autoState === "SHIPPED" || p.body.status === "DONE"), false);
  assert.equal(h.journal.readManifest(h.runId).phase, "ROLLED_BACK");
});

test("F7: a candidate push that lands despite nonzero exit still ships without releases", { timeout: 10_000 }, async (t) => {
  const h = harness(t);
  let ambiguousPush = false;
  const runner = async (cmd, args, opts) => {
    const result = await h.args.runner(cmd, args, opts);
    if (cmd === "git" && args.includes("push") && args.at(-1) === `${h.candidate}:refs/heads/main`) {
      assert.equal(result.code, 0, "the real local push landed before its exit was lost");
      ambiguousPush = true;
      return { ...result, code: 1, stderr: "connection lost after remote accepted push" };
    }
    return result;
  };
  h.state.onSleep = () => { h.state.build = short(h.originTip()); };
  const result = await ship({ ...h.args, runner });
  assert.ok(ambiguousPush);
  assert.equal(h.originTip(), h.candidate);
  assert.equal(result.outcome, "SHIPPED", "a landed push must be reconciled rather than retried");
  assert.equal(h.state.build, short(h.candidate));
  assertShipped(h);
  assert.deepEqual(h.state.posts.filter((p) => p.action === "release"), []);
  assert.equal(h.journal.readManifest(h.runId).phase, "DONE");
});
