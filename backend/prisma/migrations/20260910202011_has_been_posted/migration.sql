-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_JournalEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entryNumber" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "entryDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SAVED',
    "postedAt" DATETIME,
    "hasBeenPosted" BOOLEAN NOT NULL DEFAULT false,
    "referenceType" TEXT,
    "referenceId" INTEGER,
    "actor" TEXT NOT NULL DEFAULT 'demo@user.com',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_JournalEntry" ("actor", "createdAt", "entryDate", "entryNumber", "id", "memo", "postedAt", "referenceId", "referenceType", "status", "transactionType", "updatedAt") SELECT "actor", "createdAt", "entryDate", "entryNumber", "id", "memo", "postedAt", "referenceId", "referenceType", "status", "transactionType", "updatedAt" FROM "JournalEntry";
DROP TABLE "JournalEntry";
ALTER TABLE "new_JournalEntry" RENAME TO "JournalEntry";
CREATE UNIQUE INDEX "JournalEntry_entryNumber_key" ON "JournalEntry"("entryNumber");
CREATE INDEX "JournalEntry_transactionType_entryDate_idx" ON "JournalEntry"("transactionType", "entryDate");
CREATE INDEX "JournalEntry_referenceType_referenceId_idx" ON "JournalEntry"("referenceType", "referenceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
