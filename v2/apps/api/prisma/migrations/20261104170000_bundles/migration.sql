ALTER TABLE "Item" ADD COLUMN "isBundle" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Item" ADD COLUMN "priceCents" INTEGER;

CREATE TABLE "BundleComponent" (
    "id" SERIAL NOT NULL,
    "bundleId" INTEGER NOT NULL,
    "componentId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    CONSTRAINT "BundleComponent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BundleComponent_qty_positive" CHECK ("qty" > 0)
);

CREATE UNIQUE INDEX "BundleComponent_bundleId_componentId_key" ON "BundleComponent"("bundleId", "componentId");

ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
