#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { run } from "./run.mjs";
import { createJournal } from "./journal.mjs";
import { createFeedback } from "./feedback.mjs";
import { preflight } from "./preflight.mjs";
import { eligible } from "./intake.mjs";
import { triage, review } from "./model.mjs";
import { implementNote } from "./implement.mjs";
import { ship } from "./ship.mjs";
import { recover } from "./recover.mjs";
import { notify } from "./notify.mjs";
import { writeReport } from "./report.mjs";

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function main({ cfg, runner = run, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date() }) {
  const journal = createJournal(cfg.stateDir);
  const live = createFeedback({ api: cfg.api, token: cfg.token, fetchImpl });
  let releaseFailed = false;
  const feedback = cfg.dryRun ? { ...live, claim: async (id) => ({ ok: true, row: { id } }), outcome: async () => ({ ok: true }), question: async () => ({ ok: true }), release: async () => ({ ok: true }) } : {
    ...live,
    release: async (...args) => {
      const released = await live.release(...args);
      if (!released.ok) releaseFailed = true;
      return released;
    },
  };
  const runId = `run-${stamp(now())}`;
  const result = { runId, outcome: "NOTHING", shipped: [], failed: [], waiting: [], deferred: [], dryRun: cfg.dryRun };
  const finish = async (detail = JSON.stringify(result.failed).slice(0, 500)) => {
    journal.finish(runId, result.outcome === "SHIPPED" ? "SHIPPED" : result.outcome === "NOTHING" ? "NOTHING" : "FAILED", detail);
    const streak = journal.failureStreak();
    if (streak >= 6) {
      journal.halt("*", "6 failed runs in a row");
      await runner("systemctl", ["--user", "disable", "--now", "profitindex-autoapply.timer"], { timeoutMs: 30_000 });
      await notify(cfg, "Auto-apply STOPPED", "Six failed runs in a row: the daily job disabled itself and halted deploys. Check the vault logs, then remove the HALT file and re-enable the timer.", fetchImpl);
    } else if (streak >= 4) await notify(cfg, "Auto-apply warning", `${streak} failed runs in a row. At 6 it stops itself.`, fetchImpl);
  };
  try {
    await recover({ cfg, journal, feedback: live, runner, fetchImpl, sleep, dryRun: cfg.dryRun });
  } catch (err) {
    const reason = `recovery failed: ${err.message ?? String(err)}`;
    result.outcome = "FAILED";
    result.failed.push({ id: null, reason });
    if (!cfg.dryRun) { journal.start(runId); await finish(reason); }
    await notify(cfg, "Auto-apply crashed", reason, fetchImpl);
    await writeReport({ cfg, result, fetchImpl });
    return result;
  }
  if (!cfg.dryRun) journal.start(runId);
  const release = (id, revision) => feedback.release(id, runId, revision);
  const outcome = async (note, reason) => {
    const posted = await feedback.outcome(note.id, { runId, revision: note.revision, autoState: "FAILED", autoNote: reason });
    if (!posted.ok) await release(note.id, note.revision);
    result.failed.push({ id: note.id, reason });
  };
  try {
    const pre = await preflight({ cfg, journal, runner, fetchImpl });
    if (!pre.ok) { result.outcome = "FAILED"; result.failed.push({ id: null, reason: pre.reason }); }
    else {
      const list = await live.list();
      const notes = eligible(list.ok ? list.row : [], cfg);
      const accepted = []; let parent = pre.base;
      for (const note of notes) {
        const claim = await feedback.claim(note.id, runId, note.revision);
        if (!claim.ok) continue;
        if (!cfg.dryRun) journal.noteEvent(runId, { id: note.id, revision: note.revision, event: "claimed" });
        const t = await triage(note, { runner, cwd: join(cfg.repo, "v2"), timeoutMs: cfg.timeouts.model });
        if (t.kind === "unclear") {
          const posted = await feedback.question(note.id, runId, note.revision, t.question);
          if (posted.ok) result.waiting.push(note.id);
          else { await release(note.id, note.revision); result.failed.push({ id: note.id, reason: "question could not be posted" }); }
          continue;
        }
        if (t.kind === "error") { await outcome(note, t.reason); continue; }
        const out = await implementNote({ note, spec: t.spec, runId, parent, base: pre.base, baseImage: pre.baseImage, cfg, runner, keepWorktree: cfg.dryRun,
          reviewFn: (args) => review({ ...args, runner, cwd: join(cfg.repo, "v2"), timeoutMs: cfg.timeouts.model }) });
        if (!out.ok) { await outcome(note, out.reason); continue; }
        if (!cfg.dryRun) journal.noteEvent(runId, { id: note.id, revision: note.revision, event: "accepted", sha: out.sha });
        accepted.push({ note, sha: out.sha, migration: out.migration, title: out.title });
        parent = out.sha;
      }
      if (accepted.length && cfg.dryRun) { result.outcome = "DRY RUN"; result.shipped = accepted.map((a) => a.note.id); }
      else if (accepted.length) {
        const s = await ship({ runId, base: pre.base, accepted, cfg, journal, feedback, runner, fetchImpl, sleep });
        result.shipped = s.shipped; result.deferred = s.deferred; result.failed.push(...s.failed.map((id) => ({ id, reason: s.outcome.toLowerCase() })));
        result.outcome = ["SHIPPED", "PENDING"].includes(s.outcome) ? s.outcome : ["NOTHING", "RETRY"].includes(s.outcome) ? "NOTHING" : "FAILED";
      } else if (notes.length && !result.waiting.length) result.outcome = "FAILED";
    }
    if (!cfg.dryRun) {
      // Never finish with stranded claims, and keep release-owned notes for recovery.
      const manifest = journal.readManifest(runId);
      const inFlight = manifest && ["PREPARED", "PUSHING", "AWAITING_DEPLOY", "ROLLING_BACK", "COMPLETING"].includes(manifest.phase);
      const owned = new Set(inFlight ? manifest.notes.map((n) => n.id) : []);
      const list = await live.list();
      if (!list.ok) releaseFailed = true;
      else for (const note of list.row) {
        if (note.autoClaim === runId && !owned.has(note.id)) await release(note.id, note.autoRevision ?? note.revision);
      }
      if (releaseFailed || inFlight) result.outcome = "PENDING";
      if (result.outcome !== "PENDING") await finish();
    }
  } catch (err) {
    const reason = err.message ?? String(err);
    result.outcome = "FAILED";
    result.failed.push({ id: null, reason });
    await notify(cfg, "Auto-apply crashed", reason, fetchImpl);
    // Leave STARTED without FINISHED: recovery reconciles claims and manifests.
  }
  await writeReport({ cfg, result, fetchImpl });
  return result;
}

// CLI: hold the whole-run lock by re-executing under flock with the SAME argv (finding 5).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cfg = loadConfig({ ...process.env, ...(args.includes("--dry-run") ? { AUTO_DRY_RUN: "1" } : {}) });
  if (!args.includes("--locked")) {
    mkdirSync(cfg.stateDir, { recursive: true });
    const r = spawnSync("flock", ["-n", "-E", "0", join(cfg.stateDir, "run.lock"), process.execPath, fileURLToPath(import.meta.url), ...args, "--locked"], { stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }
  const result = await main({ cfg });
  console.log(`${result.dryRun ? "DRY RUN " : ""}${result.runId} ${result.outcome}: shipped ${result.shipped.join(",") || "-"}; failed ${result.failed.map((f) => f.id ?? "run").join(",") || "-"}; waiting ${result.waiting.join(",") || "-"}`);
}
