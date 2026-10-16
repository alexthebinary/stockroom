import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLive, pushablePrefix } from "../release.mjs";
import { run } from "../run.mjs";
const git = (r, ...a) => execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
function chain() {
  const r = join(mkdtempSync(join(tmpdir(), "rel-")), "r"); execFileSync("git", ["init", "-q", "-b", "main", r]);
  const c = (m) => { writeFileSync(join(r, `f-${m}`), m); git(r, "add", "-A"); git(r, "commit", "-qm", m); return git(r, "rev-parse", "HEAD"); };
  return { r, c };
}
test("prefix by revision: an edited note and everything after it wait", () => {
  const acc = [{ note: { id: 1, revision: 2 } }, { note: { id: 2, revision: 5 } }, { note: { id: 3, revision: 1 } }];
  assert.deepEqual(pushablePrefix(acc, new Map([[1, 2], [2, 6], [3, 1]])).map((a) => a.note.id), [1]);
  assert.deepEqual(pushablePrefix(acc, new Map([[1, 2], [2, 5], [3, 1]])).map((a) => a.note.id), [1, 2, 3]);
});
test("live build: ours, descendant, reverted, not yet", async () => {
  const { r, c } = chain(); const base = c("base"); const a = c("a"); const later = c("later");
  const short = (s) => s.slice(0, 7);
  const k = (build) => classifyLive({ runner: run, repo: r, candidate: a, accepted: [{ sha: a }], build: short(build) });
  assert.equal(await k(a), "ours");
  assert.equal(await k(later), "ours");
  assert.equal(await k(base), "not-yet");
  git(r, "revert", "--no-edit", a); const rev = git(r, "rev-parse", "HEAD");
  assert.equal(await k(rev), "reverted");
});
