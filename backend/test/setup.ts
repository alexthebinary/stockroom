/**
 * A real, disposable SQLite database per test run.
 *
 * These sequences are about what the DATABASE enforces — conditional updates
 * (`updateMany ... where status`), unique constraints, transaction boundaries.
 * A mocked Prisma client would test the mock. So: a temp file, `prisma db push`,
 * and the real client.
 *
 * DATABASE_URL is set BEFORE any import that reaches src/db.ts, because that
 * module constructs `new PrismaClient()` at import time and reads the env var
 * once. Importing anything from src/ earlier would silently bind the dev DB —
 * and the first sign would be test writes landing in prisma/dev.db.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stockroom-test-"));
export const DB_FILE = path.join(dir, "test.db");
process.env.DATABASE_URL = `file:${DB_FILE}`;
process.env.NODE_ENV = "test";
// Keep startup reconciliation quiet and deterministic.
process.env.ADMIN_PASSWORD = "test-admin-password";

execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, DATABASE_URL: `file:${DB_FILE}` },
  stdio: "pipe",
});

export function tempDbPath() {
  return DB_FILE;
}

export function cleanup() {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
