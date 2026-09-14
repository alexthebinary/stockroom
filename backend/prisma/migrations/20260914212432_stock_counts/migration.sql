-- CreateTable
CREATE TABLE "StockCount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "countNumber" TEXT NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "countedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" DATETIME,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCount_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stockCountId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER,
    CONSTRAINT "StockCountLine_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_countNumber_key" ON "StockCount"("countNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_stockCountId_productId_key" ON "StockCountLine"("stockCountId", "productId");
