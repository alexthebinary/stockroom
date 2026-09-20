-- CreateTable
CREATE TABLE "SerialUnit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "boxSerial" TEXT,
    "lotId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "warehouseId" INTEGER,
    "warrantyStartAt" DATETIME,
    "notes" TEXT,
    "serialSource" TEXT NOT NULL DEFAULT 'MANUAL',
    "ocrConfidence" REAL,
    "labelImageKey" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SerialUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SerialUnit_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "InventoryLot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SerialUnit_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WarrantyPolicy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "brand" TEXT,
    "productId" INTEGER,
    "durationMonths" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VendorProductAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "vendorId" INTEGER NOT NULL,
    "vendorProductName" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "confirmedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorProductAlias_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VendorProductAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepairOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "repairNumber" TEXT NOT NULL,
    "serialUnitId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "coverageNote" TEXT,
    "faultReported" TEXT,
    "workDone" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "actor" TEXT NOT NULL,
    CONSTRAINT "RepairOrder_serialUnitId_fkey" FOREIGN KEY ("serialUnitId") REFERENCES "SerialUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepairOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepairPartLine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "repairOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalCostCents" INTEGER NOT NULL DEFAULT 0,
    "serialNumbers" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepairPartLine_repairOrderId_fkey" FOREIGN KEY ("repairOrderId") REFERENCES "RepairOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepairPartLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepairPartLine_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SerialCorrection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "serialUnitId" INTEGER NOT NULL,
    "fromSerial" TEXT NOT NULL,
    "toSerial" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SerialCorrection_serialUnitId_fkey" FOREIGN KEY ("serialUnitId") REFERENCES "SerialUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopifyLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "lastPushedQty" INTEGER,
    "lastPushedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopifyLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopifyLocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "warehouseId" INTEGER NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopifyLocation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "barcode" TEXT,
    "category" TEXT,
    "categoryId" INTEGER,
    "brand" TEXT,
    "defaultCostCents" INTEGER NOT NULL DEFAULT 0,
    "defaultPriceCents" INTEGER NOT NULL DEFAULT 0,
    "length" REAL,
    "width" REAL,
    "height" REAL,
    "weight" REAL,
    "trackingMode" TEXT NOT NULL DEFAULT 'NONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("barcode", "brand", "category", "categoryId", "createdAt", "defaultCostCents", "defaultPriceCents", "description", "height", "id", "isActive", "length", "name", "sku", "updatedAt", "weight", "width") SELECT "barcode", "brand", "category", "categoryId", "createdAt", "defaultCostCents", "defaultPriceCents", "description", "height", "id", "isActive", "length", "name", "sku", "updatedAt", "weight", "width" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE INDEX "Product_name_idx" ON "Product"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_lotId_key" ON "SerialUnit"("lotId");

-- CreateIndex
CREATE INDEX "SerialUnit_serialNumber_idx" ON "SerialUnit"("serialNumber");

-- CreateIndex
CREATE INDEX "SerialUnit_status_warehouseId_idx" ON "SerialUnit"("status", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_productId_serialNumber_key" ON "SerialUnit"("productId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyPolicy_brand_productId_key" ON "WarrantyPolicy"("brand", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProductAlias_vendorId_vendorProductName_key" ON "VendorProductAlias"("vendorId", "vendorProductName");

-- CreateIndex
CREATE UNIQUE INDEX "RepairOrder_repairNumber_key" ON "RepairOrder"("repairNumber");

-- CreateIndex
CREATE INDEX "RepairOrder_status_idx" ON "RepairOrder"("status");

-- CreateIndex
CREATE INDEX "RepairPartLine_repairOrderId_idx" ON "RepairPartLine"("repairOrderId");

-- CreateIndex
CREATE INDEX "SerialCorrection_serialUnitId_idx" ON "SerialCorrection"("serialUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyLink_productId_key" ON "ShopifyLink"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyLocation_warehouseId_key" ON "ShopifyLocation"("warehouseId");
