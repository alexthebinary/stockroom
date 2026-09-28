-- CreateTable
CREATE TABLE "PostingRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "transactionType" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostingRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostingRuleChange" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ruleId" INTEGER NOT NULL,
    "fromAccountId" INTEGER NOT NULL,
    "toAccountId" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostingRuleChange_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PostingRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PostingRule_transactionType_role_key" ON "PostingRule"("transactionType", "role");

-- CreateIndex
CREATE INDEX "PostingRuleChange_ruleId_idx" ON "PostingRuleChange"("ruleId");
