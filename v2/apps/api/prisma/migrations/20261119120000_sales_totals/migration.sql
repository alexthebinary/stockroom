-- Additive: shipping & handling and a sales tax rate (basis points) on orders and invoices.
ALTER TABLE "SalesOrder" ADD COLUMN "shippingCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SalesOrder" ADD COLUMN "taxRateBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CustomerInvoice" ADD COLUMN "shippingCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CustomerInvoice" ADD COLUMN "taxRateBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CustomerInvoice" ADD COLUMN "taxCents" INTEGER NOT NULL DEFAULT 0;
