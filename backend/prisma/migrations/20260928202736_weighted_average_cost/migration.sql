-- CreateTable
CREATE TABLE "ProductCost" (
    "productId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable: priced share of each issue. Legacy FIFO rows cost exactly
-- quantity × unitCostCents (same statement as prisma/backfills/004 for Postgres).
ALTER TABLE "LotConsumption" ADD COLUMN "costCents" INTEGER NOT NULL DEFAULT 0;
UPDATE "LotConsumption" SET "costCents" = "quantity" * "unitCostCents"
WHERE "costCents" = 0 AND "unitCostCents" > 0;
