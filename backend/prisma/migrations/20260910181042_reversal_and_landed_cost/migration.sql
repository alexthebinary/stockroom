-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GoodsReceipt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "grnNumber" TEXT NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "warehouseId" INTEGER,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'SAVED',
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GoodsReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GoodsReceipt" ("createdAt", "grnNumber", "id", "purchaseOrderId", "receivedAt", "status", "totalCostCents", "warehouseId") SELECT "createdAt", "grnNumber", "id", "purchaseOrderId", "receivedAt", "status", "totalCostCents", "warehouseId" FROM "GoodsReceipt";
DROP TABLE "GoodsReceipt";
ALTER TABLE "new_GoodsReceipt" RENAME TO "GoodsReceipt";
CREATE UNIQUE INDEX "GoodsReceipt_grnNumber_key" ON "GoodsReceipt"("grnNumber");
CREATE TABLE "new_Shipment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shipmentNumber" TEXT NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "warehouseId" INTEGER,
    "shippedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SAVED',
    "cogsCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Shipment_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Shipment" ("carrier", "cogsCents", "createdAt", "id", "salesOrderId", "shipmentNumber", "shippedAt", "status", "trackingNumber", "warehouseId") SELECT "carrier", "cogsCents", "createdAt", "id", "salesOrderId", "shipmentNumber", "shippedAt", "status", "trackingNumber", "warehouseId" FROM "Shipment";
DROP TABLE "Shipment";
ALTER TABLE "new_Shipment" RENAME TO "Shipment";
CREATE UNIQUE INDEX "Shipment_shipmentNumber_key" ON "Shipment"("shipmentNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
