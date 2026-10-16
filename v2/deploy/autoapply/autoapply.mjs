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
  const feedback = cfg.dryRun ? { ...live, claim: async (id) => ({ ok: true, row: { id } }), outcome: async () => ({ ok: true }), question: async () => ({ ok: true }), release: async () => ({ ok: true }) } : live;
  await recover({ cfg, journal, feedback: live, runner, fetchImpl, sleep, dryRun: cfg.dryRun });
  const runId = `run-${stamp(now())}`;
  if (!cfg.dryRun) journal.start(runId);
  const result = { runId, outcome: "NOTHING", shipped: [], failed: [], waiting: [], deferred: [], dryRun: cfg.dryRun };
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
      if (t.kind === "unclear") { await feedback.question(note.id, runId, note.revision, t.question); result.waiting.push(note.id); continue; }
      if (t.kind === "error") { await feedback.outcome(note.id, { runId, revision: note.revision, autoState: "FAILED", autoNote: t.reason }); result.failed.push({ id: note.id, reason: t.reason }); continue; }
      const out = await implementNote({ note, spec: t.spec, runId, parent, base: pre.base, baseImage: pre.baseImage, cfg, runner, keepWorktree: cfg.dryRun,
        reviewFn: (args) => review({ ...args, runner, cwd: join(cfg.repo, "v2"), timeoutMs: cfg.timeouts.model }) });
      if (!out.ok) { await feedback.outcome(note.id, { runId, revision: note.revision, autoState: "FAILED", autoNote: out.reason }); result.failed.push({ id: note.id, reason: out.reason }); continue; }
      if (!cfg.dryRun) journal.noteEvent(runId, { id: note.id, revision: note.revision, event: "accepted", sha: out.sha });
      accepted.push({ note, sha: out.sha, migration: out.migration, title: out.title });
      parent = out.sha;
    }
    if (accepted.length && cfg.dryRun) { result.outcome = "DRY RUN"; result.shipped = accepted.map((a) => a.note.id); }
    else if (accepted.length) {
      const s = await ship({ runId, base: pre.base, accepted, cfg, journal, feedback, runner, fetchImpl, sleep });
      result.shipped = s.shipped; result.deferred = s.deferred; result.failed.push(...s.failed.map((id) => ({ id, reason: s.outcome.toLowerCase() })));
      result.outcome = s.outcome === "SHIPPED" ? "SHIPPED" : "FAILED";
    } else if (notes.length && !result.waiting.length) result.outcome = "FAILED";
  }
  if (!cfg.dryRun) {
    journal.finish(runId, result.outcome === "SHIPPED" ? "SHIPPED" : result.outcome === "NOTHING" ? "NOTHING" : "FAILED", JSON.stringify(result.failed).slice(0, 500));
    const streak = journal.failureStreak();
    if (streak >= 6) {
      journal.halt("*", "6 failed runs in a row");
      await runner("systemctl", ["--user", "disable", "--now", "profitindex-autoapply.timer"], { timeoutMs: 30_000 });
      await notify(cfg, "Auto-apply STOPPED", "Six failed runs in a row: the daily job disabled itself and halted deploys. Check the vault logs, then remove the HALT file and re-enable the timer.", fetchImpl);
    } else if (streak >= 4) await notify(cfg, "Auto-apply warning", `${streak} failed runs in a row. At 6 it stops itself.`, fetchImpl);
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
