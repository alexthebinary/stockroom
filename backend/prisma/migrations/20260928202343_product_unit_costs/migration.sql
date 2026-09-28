-- Product.defaultCostCents keeps its column; the Prisma field is now costOfGoodsCents (@map).
ALTER TABLE "Product" ADD COLUMN "supplierShippingCents" INTEGER NOT NULL DEFAULT 0;
