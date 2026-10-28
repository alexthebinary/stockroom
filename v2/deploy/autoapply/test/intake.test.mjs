import { test } from "node:test";
import assert from "node:assert/strict";
import { eligible } from "../intake.mjs";
const n = (id, extra = {}) => ({ id, status: "OPEN", author: "Serhii", autoClaim: null, autoState: "NONE", specState: "CONFIRMED", revision: 1, autoRevision: null, createdAt: `2026-10-${String(id).padStart(2, "0")}T00:00:00Z`, ...extra });
test("open notes from allowed authors, oldest first, capped", () => {
  const out = eligible([n(3), n(1), n(2), n(4, { author: "Stranger" }), n(5, { status: "DONE" })], { authors: ["Serhii"], maxPerRun: 2 });
  assert.deepEqual(out.map((x) => x.id), [1, 2]);
});
test("five unanswered questions do not starve a confirmed note", () => {
  const waiting = [1, 2, 3, 4, 5].map((i) => n(i, { autoState: "NEEDS_ANSWER", specState: "NONE", revision: 2, autoRevision: 2 }));
  const out = eligible([...waiting, n(6)], { authors: ["Serhii"], maxPerRun: 5 });
  assert.deepEqual(out.map((x) => x.id), [6]);
});
test("a released (deferred) note comes back, edited or not", () => {
  const out = eligible([n(1, { autoState: "QUEUED", revision: 2, autoRevision: 2 }), n(2, { autoState: "QUEUED", revision: 3, autoRevision: 2 })], { authors: ["Serhii"], maxPerRun: 5 });
  assert.deepEqual(out.map((x) => x.id), [1, 2]);
});
test("an answer (revision moved) makes a waiting or failed note eligible again; claimed ones never are", () => {
  const out = eligible([n(1, { autoState: "NEEDS_ANSWER", revision: 3, autoRevision: 2 }), n(2, { autoState: "FAILED", revision: 2, autoRevision: 2 }), n(3, { autoClaim: "r9" })], { authors: ["Serhii"], maxPerRun: 5 });
  assert.deepEqual(out.map((x) => x.id), [1]);
});
test("a note whose spec is not confirmed is never built, however many times it was answered", () => {
  const out = eligible([n(1, { specState: "NONE" }), n(2, { specState: "PROPOSED" }), n(3, { autoState: "FAILED", specState: "NONE", revision: 3, autoRevision: 2 }), n(4)], { authors: ["Serhii"], maxPerRun: 5 });
  assert.deepEqual(out.map((x) => x.id), [4]);
});
