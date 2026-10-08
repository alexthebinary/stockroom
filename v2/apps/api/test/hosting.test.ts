import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp, CONTENT_SECURITY_POLICY } from "../src/app";
import { serveWeb } from "../src/web";
import { resetDb, testDb } from "./helpers";

/** A stand-in for apps/web/dist with the same shape the PWA build produces. */
function fakeDist() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>ProfitIndex</title>");
  writeFileSync(join(root, "sw.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(root, "manifest.webmanifest"), "{}");
  writeFileSync(join(root, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "icon-192.png"), "png");
  return root;
}

describe("serving the app on the open internet", () => {
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    await resetDb();
    app = buildApp({ db: testDb(), reader: null });
    await serveWeb(app, fakeDist());
  });

  it("sends the security headers with the page and the API alike", async () => {
    for (const url of ["/", "/api/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["permissions-policy"]).toContain("camera=(self)");
    }
    expect(CONTENT_SECURITY_POLICY).toContain("'wasm-unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it("caches hashed assets for a year and always revalidates the shell and service worker", async () => {
    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    for (const url of ["/", "/sw.js", "/manifest.webmanifest"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["cache-control"], url).toBe("no-cache");
    }
    expect((await app.inject({ method: "GET", url: "/icon-192.png" })).headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("answers app routes with the shell and unknown API routes with a JSON 404", async () => {
    const route = await app.inject({ method: "GET", url: "/bills/12" });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("ProfitIndex");
    expect(route.headers["cache-control"]).toBe("no-cache");
    // Uptime monitors check with HEAD.
    expect((await app.inject({ method: "HEAD", url: "/bills/12" })).statusCode).toBe(200);
    const api = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "Not found" });
  });

  it("never lets API responses be cached", async () => {
    const res = await app.inject({ method: "GET", url: "/api/setup" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("trusts the tunnel for the client address", async () => {
    let seen = "";
    const probe = buildApp({ db: testDb(), reader: null });
    probe.get("/api/whoami-test", async (request) => (seen = request.ip));
    await probe.inject({ method: "GET", url: "/api/whoami-test", headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(seen).toBe("203.0.113.7");
  });
});
