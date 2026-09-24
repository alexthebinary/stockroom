/**
 * The built UI's assets, served by the API process (as on Render).
 *
 * 2026-09-24 a beta tester saw a blank page after a burst of deploys: a missing
 * hashed asset was answered with the SPA shell as 200 text/html, which the
 * browser can cache under the script's URL. A missing asset must be a 404.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { boot } from "./helpers";

const dist = path.resolve(__dirname, "../../frontend/dist");
const built = fs.existsSync(path.join(dist, "index.html"));
let app: Express;

beforeAll(async () => {
  ({ app } = await boot());
});

describe.skipIf(!built)("static assets", () => {
  it("a missing hashed asset is a 404, not the app shell", async () => {
    const res = await request(app).get("/assets/index-DOESNOTEXIST.js");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).not.toMatch(/html/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("a real asset is cached for a year; the shell is revalidated", async () => {
    const asset = fs.readdirSync(path.join(dist, "assets")).find((f) => f.endsWith(".js"))!;
    const a = await request(app).get(`/assets/${asset}`);
    expect(a.status).toBe(200);
    expect(a.headers["cache-control"]).toMatch(/max-age=31536000/);
    expect(a.headers["cache-control"]).toMatch(/immutable/);
    const shell = await request(app).get("/sales-orders/1");
    expect(shell.status).toBe(200);
    expect(shell.headers["content-type"]).toMatch(/html/);
    expect(shell.headers["cache-control"]).toBe("no-cache");
  });
});
