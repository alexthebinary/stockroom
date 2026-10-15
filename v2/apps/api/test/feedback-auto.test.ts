import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, ok, sampleCompany } from "./helpers";

const H = { "x-auto-token": "tok" };
async function auto(path: string, payload: unknown, headers: Record<string, string> = H) {
  const r = await client().app.inject({ method: "POST", url: path, payload: payload as never, headers });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
async function note() {
  await sampleCompany();
  return ok(await client().post("/api/feedback", { kind: "IDEA", note: "Brand filter", path: "/items", author: "Serhii" }), 201).body.id as number;
}

describe("the daily job's feedback routes", () => {
  beforeEach(() => { process.env.AUTO_TOKEN = "tok"; });
  afterEach(() => { delete process.env.AUTO_TOKEN; });

  it("are hidden without the token", async () => {
    const id = await note();
    expect((await auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 }, {})).status).toBe(404);
    delete process.env.AUTO_TOKEN;
    expect((await auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 })).status).toBe(404);
  });

  it("double claim: exactly one run gets the note", async () => {
    const id = await note();
    const [a, b] = await Promise.all([auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 }), auto(`/api/feedback/${id}/auto/claim`, { runId: "r2", revision: 1 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await auto(`/api/feedback/${id}/auto/claim`, { runId: "r3", revision: 7 })).status).toBe(409);
  });

  it("shipped outcome closes the note and frees it", async () => {
    const id = await note();
    ok(await auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 }));
    const out = ok(await auto(`/api/feedback/${id}/auto/outcome`, { runId: "r1", revision: 1, autoState: "SHIPPED", autoCommit: "abc1234", status: "DONE" })).body;
    expect(out).toMatchObject({ status: "DONE", autoState: "SHIPPED", autoCommit: "abc1234", autoClaim: null, autoRevision: 1 });
  });

  it("stale outcome: a tester edit mid-run blocks the outcome; release still frees the note", async () => {
    const id = await note();
    ok(await auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 }));
    ok(await client().post(`/api/feedback/${id}/clarify`, { message: "also by category" }));   // revision → 2 (no clarifier: unavailable path)
    expect((await auto(`/api/feedback/${id}/auto/outcome`, { runId: "r1", revision: 1, autoState: "SHIPPED", status: "DONE" })).status).toBe(409);
    expect(ok(await auto(`/api/feedback/${id}/auto/release`, { runId: "r1", revision: 1 })).body).toEqual({ released: true });
    const row = ok(await client().get("/api/feedback")).body[0];
    expect(row).toMatchObject({ status: "OPEN", autoClaim: null, revision: 2, autoRevision: 1 });
    expect((await auto(`/api/feedback/${id}/auto/claim`, { runId: "r2", revision: 2 })).status).toBe(200);
  });

  it("question adds an AI turn, waits for an answer, and frees the note", async () => {
    const id = await note();
    ok(await auto(`/api/feedback/${id}/auto/claim`, { runId: "r1", revision: 1 }));
    const row = ok(await auto(`/api/feedback/${id}/auto/question`, { runId: "r1", revision: 1, text: "Filter by brand only, or brand and category?" })).body;
    expect(row).toMatchObject({ autoState: "NEEDS_ANSWER", autoClaim: null, autoRevision: 1, turnCount: 1 });
    expect((await auto(`/api/feedback/${id}/auto/release`, { runId: "r1", revision: 1 })).body).toEqual({ released: false });
  });
});
