import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClarifier, withFallback } from "./ai/clarifier";
import { createLocalClarifier } from "./ai/local-clarifier";
import { createCloudHelpModel, createLocalHelpModel } from "./ai/help";
import { createReader } from "./ai/reader";
import { buildApp } from "./app";
import { Companies } from "./companies";
import { createDb } from "./db";
import { syncChart } from "./ledger";
import { serveWeb } from "./web";

const db = createDb();
await syncChart(db);
// Test companies (Settings > Company > New test company), each in its own schema.
const companies = new Companies(db, process.env.DATABASE_URL!);
await companies.load();
const app = buildApp({
  db,
  companies,
  reader: createReader(),
  helpModel: process.env.CLARIFY_URL && process.env.CLARIFY_SECRET
    ? createCloudHelpModel(process.env.CLARIFY_URL, process.env.CLARIFY_SECRET)
    : process.env.LOCAL_LLM_URL ? createLocalHelpModel(process.env.LOCAL_LLM_URL) : null,
  clarifier: withFallback(createClarifier(), process.env.LOCAL_LLM_URL ? createLocalClarifier(process.env.LOCAL_LLM_URL) : null),
});

// In production the API also serves the built PWA, so one container is the whole app.
const webRoot = process.env.WEB_ROOT ?? resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webRoot)) await serveWeb(app, webRoot);

const port = Number(process.env.PORT ?? 4100);
await app.listen({ port, host: "0.0.0.0" });
console.log(`ProfitIndex API on http://localhost:${port}${existsSync(webRoot) ? " (serving the web app)" : ""}`);
