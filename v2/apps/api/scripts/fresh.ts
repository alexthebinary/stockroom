/**
 * Back to a fresh install: drops every table in DATABASE_URL, re-applies the
 * migrations and seeds the chart of accounts. The next launch opens the
 * setup wizard. Refuses to run against anything that looks like production
 * unless FRESH_CONFIRM=yes is set.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { createDb } from "../src/db";
import { syncChart } from "../src/ledger";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "db"].includes(host) && process.env.FRESH_CONFIRM !== "yes") {
  console.error(`Refusing to wipe ${host}. Set FRESH_CONFIRM=yes if you really mean it.`);
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
await client.end();
execSync("npx prisma migrate deploy", { cwd: resolve(import.meta.dirname, ".."), stdio: "inherit", env: process.env });
const db = createDb(url);
await syncChart(db);
await db.$disconnect();
console.log("Fresh install ready. Start the app and the setup wizard will open.");
