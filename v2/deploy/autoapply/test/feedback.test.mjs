import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeedback } from "../feedback.mjs";
test("job routes carry the token; conflicts are not thrown", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => { seen.push({ url, headers: init.headers ?? {}, body: init.body }); return new Response(url.includes("claim") ? '{"error":"x"}' : "[]", { status: url.includes("claim") ? 409 : 200 }); };
  const fb = createFeedback({ api: "http://a", token: "tok", fetchImpl });
  assert.deepEqual(await fb.list(), { ok: true, row: [] });
  assert.equal(seen[0].url, "http://a/api/feedback?turns=1");
  assert.deepEqual(await fb.claim(3, "r1", 2), { ok: false, status: 409 });
  assert.equal(seen[1].headers["x-auto-token"], "tok");
  assert.deepEqual(JSON.parse(seen[1].body), { runId: "r1", revision: 2 });
});
