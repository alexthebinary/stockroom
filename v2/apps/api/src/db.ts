import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export { Prisma };

export function createDb(url = process.env.DATABASE_URL, schema?: string): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.");
  // The adapter's `schema` option only qualifies Prisma's own queries; raw SQL
  // (stock.ts, numbering.ts, row locks) uses search_path. Without pinning it, a
  // test company's stock, cost pools and document numbers were written to the
  // main company's tables.
  const config = schema ? { connectionString: url, options: `-c search_path=${schema}` } : { connectionString: url };
  return new PrismaClient({ adapter: new PrismaPg(config, schema ? { schema } : undefined) });
}

/**
 * One transaction for one business action. Postgres may abort a transaction
 * that lost a race (serialization or deadlock); that is reported as 409 by the
 * error handler so the client can retry, never as a 500.
 */
export function inTx<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(work, { maxWait: 10_000, timeout: 30_000 });
}
