import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

/**
 * Tests run against a real Postgres (TEST_DATABASE_URL), never a mock: the
 * CHECK constraints and the balance trigger are part of what is under test.
 * The schema is dropped and rebuilt from the migrations once per run, which
 * also proves the migrations apply to an empty database.
 */
export default async function setup() {
  const envFile = resolve(import.meta.dirname, "../../../.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2];
    }
  }
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://profitindex:profitindex@localhost:5432/profitindex_test";
  process.env.TEST_DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  execSync("npx prisma migrate deploy", { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
