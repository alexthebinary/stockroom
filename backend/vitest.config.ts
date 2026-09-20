import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A real SQLite file per run, migrated with `prisma db push`. Mocking Prisma
    // would test the mock; these sequences are about what the DATABASE enforces
    // (unique constraints, conditional updates, transaction boundaries), which a
    // mock cannot reproduce.
    globals: true,
    environment: "node",
    // SQLite serialises writers. Parallel files fighting one file DB produce
    // SQLITE_BUSY that reads as a flaky test rather than a real failure.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
  },
});
