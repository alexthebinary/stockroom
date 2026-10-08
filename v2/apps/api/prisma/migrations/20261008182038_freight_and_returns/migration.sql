-- AlterTable
ALTER TABLE "InventoryLot" ADD COLUMN     "valueCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "qtyReturned" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VendorBill" ADD COLUMN     "targetPoIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
