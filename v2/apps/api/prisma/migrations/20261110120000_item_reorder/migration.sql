-- Nullable only: existing items stay unchanged and the reorder report ignores a blank minimum.
ALTER TABLE "Item"
ADD COLUMN "reorderPoint" INTEGER,
ADD COLUMN "reorderQty" INTEGER;
