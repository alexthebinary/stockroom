import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { acquire, withLock } from "../lock.mjs";
const lockFile = () => join(mkdtempSync(join(tmpdir(), "lk-")), "deploy.lock");
test("a held lock is really held, and released", async () => {
  const f = lockFile(); const release = await acquire(f);
  assert.ok(release);
  assert.throws(() => execFileSync("flock", ["-n", "-E", "75", f, "true"]), (e) => e.status === 75);
  await release();
  execFileSync("flock", ["-n", f, "true"]);
});
test("busy lock: withLock gives up after its tries", async () => {
  const f = lockFile(); const release = await acquire(f);
  assert.deepEqual(await withLock(f, async () => "ran", { tries: 2, waitMs: 1, sleep: async () => {} }), { busy: true });
  await release();
  assert.equal(await withLock(f, async () => "ran", { tries: 1, sleep: async () => {} }), "ran");
});
