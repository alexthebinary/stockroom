import { basename } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Files that must be re-checked on every load, so an update reaches installed phones. */
const ALWAYS_FRESH = new Set(["index.html", "sw.js", "registerSW.js", "manifest.webmanifest"]);

/**
 * Serve the built PWA from the API, so one container is the whole app.
 * Hashed files under /assets never change and are cached for a year; the
 * shell and the service worker are always revalidated, which is what lets
 * `autoUpdate` roll a new version out to phones on their next open.
 */
export async function serveWeb(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false,
    setHeaders(res, path) {
      const file = basename(path);
      if (path.includes("/assets/")) res.header("Cache-Control", "public, max-age=31536000, immutable");
      else if (ALWAYS_FRESH.has(file)) res.header("Cache-Control", "no-cache");
      else res.header("Cache-Control", "public, max-age=3600");
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    return reply.status(404).send({ error: "Not found" });
  });
}
