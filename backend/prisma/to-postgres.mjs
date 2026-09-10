#!/usr/bin/env node
/**
 * Generates prisma/postgres/schema.prisma from prisma/schema.prisma.
 *
 * Derived rather than duplicated: a hand-maintained second schema drifts the
 * first time someone adds a field to only one of them.
 *
 * It lives in its own directory because Prisma ties a migration history to the
 * schema's folder, and a SQLite migration cannot be replayed on Postgres — the
 * DDL is dialect-specific (error P3019). Keeping them apart lets local work
 * use real migrations while the hosted database is created by `db push`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = new URL("./schema.prisma", import.meta.url);
const outDir = new URL("./postgres/", import.meta.url);
const out = new URL("./schema.prisma", outDir);

const original = readFileSync(src, "utf8");
if (!/provider = "sqlite"/.test(original)) {
  console.error('Expected provider = "sqlite" in schema.prisma — refusing to guess.');
  process.exit(1);
}

const converted = original.replace(
  'provider = "sqlite"',
  'provider = "postgresql"'
).replace(
  "datasource db {",
  "// GENERATED FILE — edit ../schema.prisma and re-run `npm run schema:pg`.\ndatasource db {"
);

mkdirSync(outDir, { recursive: true });
writeFileSync(out, converted);
console.log("Wrote prisma/postgres/schema.prisma (postgresql)");
console.log(
  "NOTE: `generate:pg` overwrites the generated client with the Postgres one.\n" +
    "      Run `npm run generate:local` before working against local SQLite again."
);
