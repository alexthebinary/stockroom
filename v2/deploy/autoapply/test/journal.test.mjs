import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../journal.mjs";
const dir = () => mkdtempSync(join(tmpdir(), "aa-"));

test("a started run without a finish is unfinished", () => {
  const j = createJournal(dir());
  j.start("r1"); j.start("r2"); j.finish("r2", "SHIPPED");
  assert.deepEqual(j.unfinished(), ["r1"]);
});

test("failure streak counts consecutive FAILED, ignores NOTHING, resets on SHIPPED", () => {
  const j = createJournal(dir());
  for (const [id, o] of [["a", "FAILED"], ["b", "SHIPPED"], ["c", "FAILED"], ["d", "NOTHING"], ["e", "FAILED"]]) { j.start(id); j.finish(id, o); }
  assert.equal(j.failureStreak(), 2);
});

test("HALT is a file holding the target; manifests round-trip", () => {
  const d = dir(); const j = createJournal(d);
  assert.equal(j.halted(), null);
  j.halt("abc123", "migration shipped unhealthy");
  assert.equal(j.halted(), "abc123");
  j.writeManifest({ runId: "r1", phase: "PUSHING", candidate: "c1", notes: [{ id: 3, revision: 4 }] });
  assert.equal(j.readManifest("r1").phase, "PUSHING");
  assert.equal(j.manifests().length, 1);
  j.noteEvent("r1", { id: 7, revision: 3, event: "claimed" });
  assert.deepEqual(j.readNotes("r1").map((e) => [e.id, e.event]), [[7, "claimed"]]);
  assert.deepEqual(j.readNotes("nope"), []);
});
