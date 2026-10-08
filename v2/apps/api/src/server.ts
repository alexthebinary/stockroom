import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { createReader } from "./ai/reader";
import { buildApp } from "./app";
import { createDb } from "./db";
import { syncChart } from "./ledger";

const db = createDb();
await syncChart(db);
const app = buildApp({ db, reader: createReader() });

// In production the API also serves the built PWA, so one container is the whole app.
const webRoot = process.env.WEB_ROOT ?? resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.status(404).send({ error: "Not found" });
  });
}

const port = Number(process.env.PORT ?? 4100);
await app.listen({ port, host: "0.0.0.0" });
console.log(`ProfitIndex API on http://localhost:${port}${existsSync(webRoot) ? " (serving the web app)" : ""}`);
