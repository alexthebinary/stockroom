import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export { Prisma };

export function createDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * One transaction for one business action. Postgres may abort a transaction
 * that lost a race (serialization or deadlock); that is reported as 409 by the
 * error handler so the client can retry, never as a 500.
 */
export function inTx<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(work, { maxWait: 10_000, timeout: 30_000 });
}
