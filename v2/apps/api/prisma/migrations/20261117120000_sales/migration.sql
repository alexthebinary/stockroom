-- Sales orders, customer invoices, and customer payments.
-- Accounts 1100 and 4000 already belong to the chart; insert them here so a
-- company that has not booted since this migration still has the roles.

ALTER TABLE "JournalLine" ADD COLUMN "customerId" INTEGER;
CREATE INDEX "JournalLine_customerId_idx" ON "JournalLine"("customerId");

INSERT INTO "Account" ("code", "name", "type", "normalSide", "isHeader", "purpose", "isActive")
VALUES
  ('1100', 'Accounts Receivable', 'ASSET', 'DEBIT', false, 'Amounts due from customers on sales invoices', true),
  ('4000', 'Sales Revenue', 'INCOME', 'CREDIT', false, 'Product sales recognised at invoicing (bill-and-hold)', true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "PostingRule" ("role", "accountId")
SELECT 'receivable', "id" FROM "Account" WHERE "code" = '1100'
ON CONFLICT ("role") DO NOTHING;

INSERT INTO "PostingRule" ("role", "accountId")
SELECT 'revenue', "id" FROM "Account" WHERE "code" = '4000'
ON CONFLICT ("role") DO NOTHING;

CREATE TABLE "Customer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesOrder" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" INTEGER,
    "warehouseId" INTEGER NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'OPEN',
    "invoicingStatus" TEXT NOT NULL DEFAULT 'NOT_INVOICED',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "shippingStatus" TEXT NOT NULL DEFAULT 'NOT_SHIPPED',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesOrderLine" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "qtyOrdered" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "qtyShipped" INTEGER NOT NULL DEFAULT 0,
    "qtyInvoiced" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_order_line_quantities" CHECK (
      "qtyOrdered" > 0 AND "unitPriceCents" >= 0
      AND "qtyShipped" >= 0 AND "qtyShipped" <= "qtyOrdered"
      AND "qtyInvoiced" >= 0 AND "qtyInvoiced" <= "qtyOrdered"
    )
);

CREATE TABLE "CustomerInvoice" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerId" INTEGER NOT NULL,
    "salesOrderId" INTEGER,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "termsDays" INTEGER NOT NULL DEFAULT 30,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerInvoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_invoice_amounts" CHECK ("subtotalCents" >= 0 AND "totalCents" >= 0 AND "paidCents" >= 0 AND "termsDays" >= 0)
);

CREATE TABLE "CustomerInvoiceLine" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "salesOrderLineId" INTEGER,
    "itemId" INTEGER,
    "description" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "unitPriceCents" INTEGER NOT NULL DEFAULT 0,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomerInvoiceLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_invoice_line_amounts" CHECK ("qty" >= 0 AND "unitPriceCents" >= 0 AND "amountCents" >= 0)
);

CREATE TABLE "CustomerPayment" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "customerId" INTEGER NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "memo" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_payment_amount" CHECK ("amountCents" > 0)
);

CREATE UNIQUE INDEX "SalesOrder_number_key" ON "SalesOrder"("number");
CREATE INDEX "SalesOrder_customerId_idx" ON "SalesOrder"("customerId");
CREATE INDEX "SalesOrder_lifecycle_idx" ON "SalesOrder"("lifecycle");
CREATE INDEX "SalesOrderLine_salesOrderId_idx" ON "SalesOrderLine"("salesOrderId");
CREATE UNIQUE INDEX "CustomerInvoice_number_key" ON "CustomerInvoice"("number");
CREATE INDEX "CustomerInvoice_status_idx" ON "CustomerInvoice"("status");
CREATE INDEX "CustomerInvoice_customerId_idx" ON "CustomerInvoice"("customerId");
CREATE INDEX "CustomerInvoice_salesOrderId_idx" ON "CustomerInvoice"("salesOrderId");
CREATE INDEX "CustomerInvoiceLine_invoiceId_idx" ON "CustomerInvoiceLine"("invoiceId");
CREATE UNIQUE INDEX "CustomerPayment_number_key" ON "CustomerPayment"("number");
CREATE INDEX "CustomerPayment_invoiceId_idx" ON "CustomerPayment"("invoiceId");

ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "SalesOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
