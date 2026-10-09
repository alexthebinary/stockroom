import { describe, expect, it } from "vitest";
import { client, ok, sampleCompany } from "./helpers";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("beta feedback", () => {
  it("a tester pins a note, with a screenshot, and it comes back for the list, the page and Claude", async () => {
    const c = await sampleCompany();
    // From "Who's working?": nobody picked on this device yet, the team exists.
    const anon = client();
    const { id } = ok(
      await anon.post("/api/feedback", {
        kind: "BUG",
        note: "The Continue button\ndid nothing",
        path: "/bills/1",
        pageTitle: "Bill",
        anchor: { selector: "main > button:nth-of-type(2)", label: "Hold to post bill", offsetX: 0.5, offsetY: 0.5 },
        context: { viewport: "390×844", build: "abc123", errors: [{ at: "10:42", message: "POST /bills/1/post → 409" }] },
        author: "Bea Tester",
        screenshot: PNG,
      }),
      201,
    ).body;
    ok(await c.clerk.post("/api/feedback", { kind: "IDEA", note: "Bigger scan button", path: "/receive" }), 201);

    const onPage = ok(await anon.get("/api/feedback?path=/bills/1")).body;
    expect(onPage).toHaveLength(1);
    expect(onPage[0]).toMatchObject({ id, author: "Bea Tester", status: "OPEN", hasScreenshot: true });
    expect(ok(await anon.get("/api/feedback")).body.find((f: { kind: string }) => f.kind === "IDEA")).toMatchObject({ author: "Cal Clerk", authorJob: "CLERK" });

    const image = await client().app.inject({ method: "GET", url: `/api/feedback/${id}/screenshot` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.subarray(1, 4).toString()).toBe("PNG");

    const md = await client().app.inject({ method: "GET", url: "/api/feedback/export.md" });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Feedback (open, 2)");
    expect(md.body).toContain("## #1 bug · `/bills/1` (Bill)");
    expect(md.body).toContain("> did nothing");
    expect(md.body).toContain('On: "Hold to post bill"');
    expect(md.body).toContain("POST /bills/1/post → 409");
    expect(md.body).toContain(`/api/feedback/${id}/screenshot`);

    expect(ok(await c.admin.patch(`/api/feedback/${id}`, { status: "DONE" })).body.status).toBe("DONE");
    expect(ok(await anon.get("/api/feedback?status=OPEN")).body).toHaveLength(1);
  });
});
