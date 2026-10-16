import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const pushablePrefix = (accepted, fresh) => { const out = []; for (const a of accepted) { if (fresh.get(a.note.id) !== a.note.revision) break; out.push(a); } return out; };

const git = (runner, repo, ...args) => runner("git", ["-C", repo, ...args], { timeoutMs: 60_000 });

/** Is the live build our release (or built on it, without undoing it)? */
export async function classifyLive({ runner, repo, candidate, accepted, build }) {
  if (!build || build === "dev") return "not-yet";
  const full = (await git(runner, repo, "rev-parse", "--verify", "--quiet", `${build}^{commit}`)).stdout.trim();
  if (!full) return "not-yet";
  if ((await git(runner, repo, "merge-base", "--is-ancestor", candidate, full)).code !== 0) return "not-yet";
  const between = (await git(runner, repo, "log", "--format=%B", `${candidate}..${full}`)).stdout;
  const reverted = new Set([...between.matchAll(/This reverts commit ([0-9a-f]{40})\./g)].map((m) => m[1]));
  return accepted.some((a) => reverted.has(a.sha)) ? "reverted" : "ours";
}

/** The receipt of the first deployed commit in base..build that has one (its backup predates our migration). */
export async function findReceipt({ receiptsDir, runner, repo, base, build }) {
  if (!existsSync(receiptsDir) || !build) return null;
  const range = (await git(runner, repo, "rev-list", "--reverse", `${base}..${build}`)).stdout.split("\n").filter(Boolean);
  const have = new Set(readdirSync(receiptsDir).filter((f) => /^receipt-[0-9a-f]{40}\.json$/.test(f)).map((f) => f.slice(8, 48)));
  const first = range.find((sha) => have.has(sha));
  return first ? JSON.parse(readFileSync(join(receiptsDir, `receipt-${first}.json`), "utf8")) : null;
}
