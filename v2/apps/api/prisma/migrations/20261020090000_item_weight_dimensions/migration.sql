-- Optional item measurements; existing items remain unmeasured.
ALTER TABLE "Item"
  ADD COLUMN "weightKg" DOUBLE PRECISION,
  ADD COLUMN "lengthCm" DOUBLE PRECISION,
  ADD COLUMN "widthCm" DOUBLE PRECISION,
  ADD COLUMN "heightCm" DOUBLE PRECISION;
