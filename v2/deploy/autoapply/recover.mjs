import { complete, resolveStuck } from "./ship.mjs";
import { withLock } from "./lock.mjs";

const git = (runner, repo, ...args) => runner("git", ["-C", repo, ...args], { timeoutMs: 120_000 });

/** Reconcile every run that started but never finished, BEFORE any new work (spec Part 2: recovery on start). */
export async function recover({ cfg, journal, feedback, runner, fetchImpl = fetch, sleep, dryRun = false }) {
  const recovered = [];
  for (const runId of journal.unfinished()) {
    const m = journal.readManifest(runId);
    const phase = m?.phase ?? "NO_MANIFEST";
    const list = await feedback.list();
    const claimed = new Map();
    for (const e of journal.readNotes(runId)) if (e.event === "claimed") claimed.set(e.id, e.revision);
    for (const n of list.ok ? list.row : []) if (n.autoClaim === runId) claimed.set(n.id, n.autoRevision);
    if (dryRun) { recovered.push({ runId, phase, result: `would reconcile ${claimed.size} claim(s)` }); continue; }
    if (!list.ok) { recovered.push({ runId, phase, result: "PENDING" }); continue; }
    let result = "released";
    let man = m;
    if (phase === "PUSHING") {
      const reconciled = await withLock(cfg.deployLock, async () => {
        const fetched = await git(runner, cfg.repo, "fetch", "--quiet", "origin", cfg.branch);
        if (fetched.code !== 0) throw new Error("could not fetch the deployment branch");
        const origin = await git(runner, cfg.repo, "merge-base", "--is-ancestor", m.candidate, `origin/${cfg.branch}`);
        if (![0, 1].includes(origin.code)) throw new Error("could not classify the deployment branch");
        const next = { ...m, phase: origin.code === 0 ? "AWAITING_DEPLOY" : "ABANDONED" };
        journal.writeManifest(next);
        return next;
      }, { sleep });
      if (reconciled?.busy) { recovered.push({ runId, phase, result: "PENDING" }); continue; }
      man = reconciled;
    }
    if (man && ["AWAITING_DEPLOY", "ROLLING_BACK"].includes(man.phase)) {
      result = (await resolveStuck({ manifest: man, cfg, journal, feedback, runner, fetchImpl, sleep })).outcome;
    } else if (man?.phase === "COMPLETING") {
      result = (await complete({ manifest: man, journal, feedback })).outcome;
    }
    if (result === "PENDING") { recovered.push({ runId, phase, result }); continue; }
    for (const [id, revision] of claimed) {
      const released = await feedback.release(id, runId, revision);
      if (!released.ok) result = "PENDING";
    }
    if (result === "PENDING") { recovered.push({ runId, phase, result }); continue; }
    journal.finish(runId, "FAILED", `recovered: ${phase} → ${result}`);
    recovered.push({ runId, phase, result });
  }
  return { recovered };
}
