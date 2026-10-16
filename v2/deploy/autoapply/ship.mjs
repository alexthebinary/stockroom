import { join } from "node:path";
import { withLock } from "./lock.mjs";
import { classifyLive, findReceipt, pushablePrefix } from "./release.mjs";
import { notify } from "./notify.mjs";

const git = (runner, repo, ...args) => runner("git", ["-C", repo, ...args], { timeoutMs: 120_000 });
const tip = async (runner, cfg) => {
  const fetched = await git(runner, cfg.repo, "fetch", "--quiet", "origin", cfg.branch);
  if (fetched.code !== 0) throw new Error("could not fetch the deployment branch");
  const remote = await git(runner, cfg.repo, "rev-parse", `origin/${cfg.branch}`);
  if (remote.code !== 0) throw new Error("could not read the deployment branch");
  return remote.stdout.trim();
};
async function live(cfg, fetchImpl) {
  try {
    const h = await (await fetchImpl(`${cfg.api}/api/health`, { signal: AbortSignal.timeout(10_000) })).json();
    const b = await (await fetchImpl(`${cfg.api}/api/books/check`, { signal: AbortSignal.timeout(20_000) })).json();
    return { build: h?.ok ? h.build : null, sound: b?.sound === true };
  } catch { return { build: null, sound: false }; }
}
const releaseAll = async (feedback, runId, notes) => { for (const n of notes) await feedback.release(n.id, runId, n.revision); };
const failAll = async (feedback, m, reason) => { for (const n of m.notes) { const r = await feedback.outcome(n.id, { runId: m.runId, revision: n.revision, autoState: "FAILED", autoNote: reason }); if (!r.ok) await feedback.release(n.id, m.runId, n.revision); } };

export async function complete({ manifest, journal, feedback }) {
  journal.writeManifest({ ...manifest, phase: "COMPLETING" });
  const shipped = [], deferred = [];
  for (const n of manifest.notes) {
    const r = await feedback.outcome(n.id, n.payload);
    if (r.ok) shipped.push(n.id);
    else if (r.status !== 409 || !(await feedback.release(n.id, manifest.runId, n.revision)).ok) deferred.push(n.id);
  }
  if (deferred.length) return { outcome: "PENDING", shipped, failed: [], deferred };
  journal.writeManifest({ ...manifest, phase: "DONE" });
  return { outcome: "SHIPPED", shipped, failed: [], deferred: [] };
}

/** Poll (no lock) until our release is live, it was reverted, or time runs out. */
async function waitLive({ manifest, cfg, runner, fetchImpl, sleep, sha = manifest.candidate, accepted = manifest.notes }) {
  const deadline = Date.now() + cfg.timeouts.deploy;
  while (Date.now() < deadline) {
    const now = await live(cfg, fetchImpl);
    const k = await classifyLive({ runner, repo: cfg.repo, candidate: sha, accepted, build: now.build });
    if (k === "reverted") return "reverted";
    if (k === "ours" && now.sound) return "ours";
    await sleep(15_000);
  }
  return "timeout";
}

/** The ONE decision for a release that did not come up in time — always under B1's deploy lock. */
export async function resolveStuck({ manifest, cfg, journal, feedback, runner, fetchImpl, sleep }) {
  const decided = await withLock(cfg.deployLock, async () => {
    const remote = await tip(runner, cfg);
    const halted = journal.halted();
    const now = await live(cfg, fetchImpl);
    if (manifest.phase === "ROLLING_BACK") {
      const back = await classifyLive({ runner, repo: cfg.repo, candidate: manifest.revert, accepted: [], build: now.build });
      if (back === "ours" && now.sound) return "rolled-back";
      return "rolling-back";
    }
    const k = await classifyLive({ runner, repo: cfg.repo, candidate: manifest.candidate, accepted: manifest.notes, build: now.build });
    if (k === "ours" && now.sound) return "complete";
    if (k === "reverted") return "reverted";
    if (halted || manifest.migration) {
      if (halted) { journal.writeManifest({ ...manifest, phase: "HALTED" }); return "halted"; }
      journal.halt(manifest.candidate, "release with a migration did not come up");
      journal.writeManifest({ ...manifest, phase: "HALTED" });
      const receipt = await findReceipt({ receiptsDir: cfg.receiptsDir, runner, repo: cfg.repo, base: manifest.base, build: remote });
      await notify(cfg, "Auto-apply HALTED", `Release ${manifest.candidate.slice(0, 7)} (with a database migration) is not healthy. Deploys are halted. Restore: ${receipt ? `deploy/restore.sh ${receipt.backup}` : "no receipt: the candidate never started deploying"}; then remove the HALT file.`, fetchImpl);
      return "halted";
    }
    if (remote !== manifest.candidate) {
      journal.halt(manifest.candidate, "unhealthy release with commits on top");
      journal.writeManifest({ ...manifest, phase: "HALTED" });
      await notify(cfg, "Auto-apply HALTED", `Release ${manifest.candidate.slice(0, 7)} is unhealthy and the branch moved on top of it; not reverting automatically.`, fetchImpl);
      return "halted";
    }
    const wt = join(cfg.workDir, manifest.runId, "revert");
    await git(runner, cfg.repo, "worktree", "add", "--detach", "--force", wt, manifest.candidate);
    const reverted = await runner("git", ["-C", wt, "-c", "user.name=ProfitIndex auto-apply", "-c", "user.email=noreply@stockroom.local", "revert", "--no-edit", `${manifest.base}..${manifest.candidate}`], { timeoutMs: 120_000 });
    const revertSha = (await git(runner, wt, "rev-parse", "HEAD")).stdout.trim();
    const pushed = reverted.code === 0 && (await git(runner, wt, "push", "origin", `${revertSha}:refs/heads/${cfg.branch}`)).code === 0;
    await git(runner, cfg.repo, "worktree", "remove", "--force", wt);
    if (!pushed) { journal.halt("*", "rollback push failed"); journal.writeManifest({ ...manifest, phase: "HALTED" }); await notify(cfg, "Auto-apply HALTED", "The automatic rollback could not be pushed. Deploys are halted.", fetchImpl); return "halted"; }
    journal.writeManifest({ ...manifest, phase: "ROLLING_BACK", revert: revertSha });
    return "rolling-back";
  }, { sleep });
  if (decided?.busy) return { outcome: "PENDING", shipped: [], failed: [], deferred: [] };
  if (decided === "complete") return complete({ manifest, journal, feedback });
  if (decided === "reverted") { await failAll(feedback, manifest, "reverted after shipping"); journal.writeManifest({ ...manifest, phase: "ROLLED_BACK" }); return { outcome: "ROLLED_BACK", shipped: [], failed: manifest.notes.map((n) => n.id), deferred: [] }; }
  if (decided === "halted") { await failAll(feedback, manifest, "halted: needs operator"); return { outcome: "HALTED", shipped: [], failed: manifest.notes.map((n) => n.id), deferred: [] }; }
  const m = journal.readManifest(manifest.runId);
  const back = decided === "rolled-back" ? "ours" : await waitLive({ manifest: m, cfg, runner, fetchImpl, sleep, sha: m.revert, accepted: [] });
  if (back !== "ours") {
    const checked = await withLock(cfg.deployLock, async () => {
      await tip(runner, cfg);
      journal.halted();
      const now = await live(cfg, fetchImpl);
      const k = await classifyLive({ runner, repo: cfg.repo, candidate: m.revert, accepted: [], build: now.build });
      if (k === "ours" && now.sound) return "rolled-back";
      journal.halt("*", "rollback did not come up");
      journal.writeManifest({ ...m, phase: "HALTED" });
      await notify(cfg, "Auto-apply HALTED", "The automatic rollback did not come up healthy. Deploys are halted.", fetchImpl);
      return "halted";
    }, { sleep });
    if (checked?.busy) return { outcome: "PENDING", shipped: [], failed: [], deferred: [] };
    if (checked === "halted") { await failAll(feedback, m, "halted: needs operator"); return { outcome: "HALTED", shipped: [], failed: m.notes.map((n) => n.id), deferred: [] }; }
  }
  await failAll(feedback, m, "rolled back: unhealthy after deploy");
  journal.writeManifest({ ...m, phase: "ROLLED_BACK" });
  await notify(cfg, "Auto-apply rolled back", `Release ${m.candidate.slice(0, 7)} was unhealthy and has been reverted.`, fetchImpl);
  return { outcome: "ROLLED_BACK", shipped: [], failed: m.notes.map((n) => n.id), deferred: [] };
}

export async function ship({ runId, base, accepted, cfg, journal, feedback, runner, fetchImpl = fetch, sleep }) {
  const list = await feedback.list();
  const fresh = new Map((list.ok ? list.row : []).map((n) => [n.id, n.revision]));
  const prefix = pushablePrefix(accepted, fresh);
  const deferred = accepted.slice(prefix.length);
  for (const d of deferred) await feedback.release(d.note.id, runId, d.note.revision);
  if (!prefix.length) return { outcome: "NOTHING", shipped: [], failed: [], deferred: deferred.map((d) => d.note.id) };
  const manifest = {
    runId, base, candidate: prefix.at(-1).sha, migration: prefix.some((a) => a.migration), phase: "PREPARED",
    notes: prefix.map((a) => ({ id: a.note.id, revision: a.note.revision, sha: a.sha, payload: { runId, revision: a.note.revision, autoState: "SHIPPED", autoCommit: a.sha, status: "DONE" } })),
  };
  journal.writeManifest(manifest);
  const pushed = await withLock(cfg.deployLock, async () => {
    const remote = await tip(runner, cfg);
    const halted = journal.halted();
    await live(cfg, fetchImpl);
    if (halted) return "halted";
    if (remote !== base) return "moved";
    journal.writeManifest({ ...manifest, phase: "PUSHING" });
    const p = await git(runner, cfg.repo, "push", "origin", `${manifest.candidate}:refs/heads/${cfg.branch}`);
    if (p.code !== 0) return "moved";
    journal.writeManifest({ ...manifest, phase: "AWAITING_DEPLOY" });
    return "pushed";
  }, { sleep });
  if (pushed?.busy) return { outcome: "PENDING", shipped: [], failed: [], deferred: deferred.map((d) => d.note.id) };
  if (pushed !== "pushed") {
    await releaseAll(feedback, runId, manifest.notes);
    journal.writeManifest({ ...manifest, phase: "ABANDONED" });
    const outcome = pushed === "halted" ? "HALTED" : "RETRY";
    return { outcome, shipped: [], failed: [], deferred: [...manifest.notes.map((n) => n.id), ...deferred.map((d) => d.note.id)] };
  }
  const waited = await waitLive({ manifest, cfg, runner, fetchImpl, sleep });
  const m = { ...manifest, phase: "AWAITING_DEPLOY" };
  if (waited === "ours") { const result = await complete({ manifest: m, journal, feedback }); return { ...result, deferred: [...result.deferred, ...deferred.map((d) => d.note.id)] }; }
  if (waited === "reverted") { await failAll(feedback, m, "reverted after shipping"); journal.writeManifest({ ...m, phase: "ROLLED_BACK" }); return { outcome: "ROLLED_BACK", shipped: [], failed: m.notes.map((n) => n.id), deferred: deferred.map((d) => d.note.id) }; }
  const result = await resolveStuck({ manifest: m, cfg, journal, feedback, runner, fetchImpl, sleep });
  return { ...result, deferred: [...result.deferred, ...deferred.map((d) => d.note.id)] };
}
