-- CreateTable
CREATE TABLE "SalesReturn" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "returnNumber" TEXT NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "creditCents" INTEGER NOT NULL DEFAULT 0,
    "refundCents" INTEGER NOT NULL DEFAULT 0,
    "restockCostCents" INTEGER NOT NULL DEFAULT 0,
    "refundMethod" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesReturn_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesReturnLine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "salesReturnId" INTEGER NOT NULL,
    "salesOrderLineId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL,
    "warehouseId" INTEGER,
    "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
    "unitCostCents" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SalesReturnLine_salesReturnId_fkey" FOREIGN KEY ("salesReturnId") REFERENCES "SalesReturn" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesReturnLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "SalesOrderLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SalesOrderLine" (
    "shippedQty" INTEGER NOT NULL DEFAULT 0,
    "returnedQty" INTEGER NOT NULL DEFAULT 0,
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "salesOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
    "lineTotalCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    CONSTRAINT "SalesOrderLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SalesOrderLine_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SalesOrderLine" ("id", "lineTotalCents", "productId", "quantity", "salesOrderId", "shippedQty", "status", "unitPriceCents", "warehouseId") SELECT "id", "lineTotalCents", "productId", "quantity", "salesOrderId", "shippedQty", "status", "unitPriceCents", "warehouseId" FROM "SalesOrderLine";
DROP TABLE "SalesOrderLine";
ALTER TABLE "new_SalesOrderLine" RENAME TO "SalesOrderLine";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SalesReturn_returnNumber_key" ON "SalesReturn"("returnNumber");
