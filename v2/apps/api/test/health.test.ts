import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { client } from "./helpers";

describe("health", () => {
  afterEach(() => { delete process.env.APP_VERSION; });

  it("reports the running build after a database round-trip", async () => {
    process.env.APP_VERSION = "abc1234";
    const r = await client().app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, build: "abc1234" });
  });

  it("says dev when no version was built in", async () => {
    expect((await client().app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true, build: "dev" });
  });

  it("publishes the state machines for the help assistant and the web", async () => {
    const body = (await client().app.inject({ method: "GET", url: "/api/state-machines" })).json();
    expect(body.machines.bill.initial).toBe("DRAFT");
    expect(body.machines.poLifecycle.edges).toEqual({ OPEN: ["CANCELED"], CANCELED: ["CANCELED"] });
    expect(body.machines.poLifecycle.edges.CLOSED).toBeUndefined();
    expect(body.derived.billingStatus).toEqual(["NOT_BILLED", "DRAFT", "BILLED"]);
    expect(body.derived.receiptState).toEqual(["PENDING_BILL", "PARTIAL", "POSTED"]);
  });

  it("is 503 when the database does not answer", async () => {
    const db = { $queryRaw: async () => { throw new Error("connection refused"); } } as never;
    const r = await buildApp({ db, reader: null }).inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ ok: false, build: "dev" });
  });
});
