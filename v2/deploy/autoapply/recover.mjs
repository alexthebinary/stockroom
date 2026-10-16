import { resolveStuck } from "./ship.mjs";
import { withLock } from "./lock.mjs";

const git = (runner, repo, ...args) => runner("git", ["-C", repo, ...args], { timeoutMs: 120_000 });

/** Reconcile unfinished runs and stranded release manifests BEFORE any new work. */
export async function recover({ cfg, journal, feedback, runner, fetchImpl = fetch, sleep, dryRun = false }) {
  const recovered = [];
  const inFlight = ["PREPARED", "PUSHING", "AWAITING_DEPLOY", "ROLLING_BACK", "COMPLETING"];
  const runIds = new Set([...journal.unfinished(), ...journal.manifests().filter((m) => inFlight.includes(m.phase)).map((m) => m.runId)]);
  for (const runId of runIds) {
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
    if (["PREPARED", "PUSHING"].includes(phase)) {
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
    if (man && ["AWAITING_DEPLOY", "ROLLING_BACK", "COMPLETING"].includes(man.phase)) {
      result = (await resolveStuck({ manifest: man, cfg, journal, feedback, runner, fetchImpl, sleep })).outcome;
    }
    if (result === "PENDING") { recovered.push({ runId, phase, result }); continue; }
    for (const [id, revision] of claimed) {
      const released = await feedback.release(id, runId, revision);
      if (!released.ok) result = "PENDING";
    }
    if (result === "PENDING") {
      // Legacy FINISHED rows cannot keep a failed cleanup discoverable by themselves.
      const current = journal.readManifest(runId);
      if (m && inFlight.includes(phase) && current && !inFlight.includes(current.phase)) {
        journal.writeManifest({ ...current, phase: current.revert ? "ROLLING_BACK" : phase });
      }
      recovered.push({ runId, phase, result }); continue;
    }
    journal.finish(runId, "FAILED", `recovered: ${phase} → ${result}`);
    recovered.push({ runId, phase, result });
  }
  return { recovered };
}
