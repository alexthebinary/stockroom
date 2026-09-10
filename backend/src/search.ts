/**
 * Case-insensitive text search that works on both providers.
 *
 * SQLite's `contains` is already case-insensitive for ASCII; Postgres's is
 * NOT, and Prisma only accepts `mode: "insensitive"` on Postgres — passing it
 * to SQLite is a validation error. So the filter has to be built to match the
 * provider rather than hardcoded, or search silently stops finding "widget"
 * when the user types "Widget" the moment this is deployed on Postgres.
 */
const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");

export function contains(value: string) {
  return isPostgres
    ? ({ contains: value, mode: "insensitive" } as const)
    : ({ contains: value } as const);
}
