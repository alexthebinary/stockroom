-- One posted invoice number per vendor. Drafts may share a number; void frees it.
-- Case-insensitive so "INV-1" and "inv-1" cannot both post.
CREATE UNIQUE INDEX "VendorBill_posted_invoice_key"
ON "VendorBill" ("vendorId", lower("vendorInvoiceNumber"))
WHERE "status" = 'POSTED' AND "vendorId" IS NOT NULL AND "vendorInvoiceNumber" IS NOT NULL;
