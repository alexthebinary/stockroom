import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import pg from "pg";

const v2Dir = resolve(import.meta.dirname, "../../..");
const dbPrefix = "profitindex_test_";

async function worktreeDatabaseUrl(): Promise<string> {
  const gitOptions = { cwd: v2Dir, encoding: "utf8" } as const;
  const branch = execFileSync("git", ["branch", "--show-current"], gitOptions).trim();
  // wt-new uses team/<name> for its branches. Detached worktrees use their directory name.
  const worktree = branch.replace(/^team\//, "") || basename(resolve(v2Dir, ".."));
  const database = (dbPrefix + worktree.toLowerCase().replace(/[^a-z0-9_]/g, "_")).slice(0, 63);
  const url = new URL("postgresql://profitindex:profitindex@localhost:5432/postgres");
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${database}"`);
  } catch (error) {
    if (!(error instanceof pg.DatabaseError) || error.code !== "42P04") throw error;
  } finally {
    await client.end();
  }
  url.pathname = database;
  return url.href;
}

/**
 * Tests run against a real Postgres (TEST_DATABASE_URL), never a mock: the
 * CHECK constraints and the balance trigger are part of what is under test.
 * The schema is dropped and rebuilt from the migrations once per run, which
 * also proves the migrations apply to an empty database.
 */
export default async function setup() {
  const envFile = resolve(v2Dir, ".env");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL ?? await worktreeDatabaseUrl();
  // Vitest copies the parent process environment when it launches its workers.
  process.env.TEST_DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
  execSync("npx prisma migrate deploy", { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
