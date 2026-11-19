import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, ok, resetDb, sampleCompany } from "./helpers";

const H = { "x-auto-token": "tok" };

async function call(method: "POST" | "PATCH", url: string, payload: unknown, headers: Record<string, string> = H) {
  const response = await client().app.inject({ method, url, payload: payload as never, headers });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}

describe("questions for Serhii", () => {
  beforeEach(() => { process.env.AUTO_TOKEN = "tok"; });
  afterEach(() => { delete process.env.AUTO_TOKEN; });

  it("creating needs the token", async () => {
    await resetDb();
    const body = { text: "Which account should freight use?" };
    expect((await call("POST", "/api/questions", body, {})).status).toBe(404);
    expect((await call("POST", "/api/questions", body, { "x-auto-token": "nope" })).body.error).toBe("That route was not found");
    delete process.env.AUTO_TOKEN;
    expect((await call("POST", "/api/questions", body)).status).toBe(404);
    process.env.AUTO_TOKEN = "tok";
    const created = ok(await call("POST", "/api/questions", body), 201).body;
    expect(created).toMatchObject({ text: body.text, status: "OPEN", askedBy: "Claude", context: null, feedbackIds: [], answer: null });
  });

  it("lists newest first and filters by status", async () => {
    await resetDb();
    const first = ok(await call("POST", "/api/questions", { text: "First", context: "About the freight line", feedbackIds: [57, 58, 57] }), 201).body;
    const second = ok(await call("POST", "/api/questions", { text: "Second" }), 201).body;
    const all = ok(await client().get("/api/questions")).body as { id: number; text: string }[];
    expect(all.map((row) => row.id)).toEqual([second.id, first.id]);
    expect(all[1]).toMatchObject({ context: "About the freight line", feedbackIds: [57, 58] });
    expect(ok(await client().get("/api/questions?status=OPEN")).body.map((row: { text: string }) => row.text)).toEqual(["Second", "First"]);
    expect(ok(await client().get("/api/questions?status=ANSWERED")).body).toEqual([]);
    ok(await call("PATCH", `/api/questions/${first.id}`, { status: "WITHDRAWN" }));
    expect(ok(await client().get("/api/questions?status=WITHDRAWN")).body.map((row: { id: number }) => row.id)).toEqual([first.id]);
  });

  it("an answer sets the fields and a second answer overwrites them", async () => {
    const { profiles } = await sampleCompany();
    const id = ok(await call("POST", "/api/questions", { text: "Which account?" }), 201).body.id as number;
    const accountant = client(profiles.accountant.id);
    const answered = ok(await accountant.post(`/api/questions/${id}/answer`, { answer: "Freight in" })).body;
    expect(answered).toMatchObject({ status: "ANSWERED", answer: "Freight in", answeredBy: "Ann Accountant" });
    expect(typeof answered.answeredAt).toBe("string");
    const again = ok(await accountant.post(`/api/questions/${id}/answer`, { answer: "Use Freight In, account 5100" })).body;
    expect(again).toMatchObject({ status: "ANSWERED", answer: "Use Freight In, account 5100", answeredBy: "Ann Accountant" });
    expect(again.answeredAt >= answered.answeredAt).toBe(true);
    expect((await accountant.post(`/api/questions/${id}/answer`, { answer: "" })).status).toBe(400);
  });

  it("withdrawing hides the question from the open list", async () => {
    await resetDb();
    const id = ok(await call("POST", "/api/questions", { text: "Still open?" }), 201).body.id as number;
    expect((await call("PATCH", `/api/questions/${id}`, { status: "WITHDRAWN" }, {})).status).toBe(404);
    ok(await call("PATCH", `/api/questions/${id}`, { status: "WITHDRAWN" }));
    const open = ok(await client().get("/api/questions?status=OPEN")).body as { id: number }[];
    expect(open.map((row) => row.id)).not.toContain(id);
    expect(ok(await client().get(`/api/questions?status=WITHDRAWN`)).body[0]).toMatchObject({ id, status: "WITHDRAWN" });
    ok(await call("PATCH", `/api/questions/${id}`, { status: "OPEN" }));
    expect(ok(await client().get("/api/questions?status=OPEN")).body.map((row: { id: number }) => row.id)).toContain(id);
  });
});
