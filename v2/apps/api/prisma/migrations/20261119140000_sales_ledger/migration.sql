-- Sales shipments park average cost in inventory shipped-not-invoiced until the invoice recognizes COGS.
ALTER TABLE "SalesOrderLine" ADD COLUMN "qtyCosted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesOrderLine" ADD COLUMN "shippedValueCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesOrderLine" ADD COLUMN "cogsCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CustomerInvoiceLine" ADD COLUMN "qtyCosted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CustomerInvoiceLine" ADD COLUMN "cogsCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "JournalLine" ADD COLUMN "soLineId" INTEGER;
CREATE INDEX "JournalLine_soLineId_idx" ON "JournalLine"("soLineId");

-- Existing shipments were already expensed to COGS. Leave those journal entries as they are.
UPDATE "SalesOrderLine" SET "qtyCosted" = "qtyShipped" WHERE "qtyShipped" <> "qtyCosted";
