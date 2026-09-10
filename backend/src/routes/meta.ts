import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { prisma } from "../db";
import { asyncHandler } from "../http";
import {
  ADJUSTMENT_TYPES,
  MOVEMENT_TYPES,
  PURCHASE_ORDER_STATUSES,
  READINESS_STATUSES,
  SO_PAYMENT_STATUSES,
  TRANSFER_STATUSES,
} from "../domain";

export const metaRouter = Router();

/**
 * Counts `model` blocks in the Prisma schema.
 *
 * A hardcoded number would drift the moment someone adds a table, and the page
 * would keep claiming completeness while omitting it. Falls back to the number
 * described if the file cannot be read (a packaged deploy may not ship it),
 * which is the honest degradation: no false claim either way.
 */
function countModelsInSchema(): number | null {
  const candidates = [
    path.resolve(__dirname, "../../prisma/schema.prisma"),
    path.resolve(__dirname, "../../../prisma/schema.prisma"),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      return (text.match(/^model /gm) ?? []).length;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Describes the system to itself, for the About page.
 *
 * The row counts and vocabularies are read live rather than written into the
 * documentation, so the page cannot drift from the running schema. If a status
 * value is added to domain.ts it appears here without anyone editing prose.
 */
metaRouter.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    const [
      products,
      categories,
      warehouses,
      customers,
      vendors,
      employees,
      balances,
      movements,
      lots,
      consumptions,
      accounts,
      templates,
      entries,
      lines,
      salesOrders,
      purchaseOrders,
      invoices,
      bills,
      payments,
      shipments,
      receipts,
      transfers,
      adjustments,
      salesOrderLines,
      purchaseOrderLines,
    ] = await Promise.all([
      prisma.product.count(),
      prisma.productCategory.count(),
      prisma.warehouse.count(),
      prisma.customer.count(),
      prisma.vendor.count(),
      prisma.employee.count(),
      prisma.inventoryBalance.count(),
      prisma.inventoryMovement.count(),
      prisma.inventoryLot.count(),
      prisma.lotConsumption.count(),
      prisma.account.count(),
      prisma.journalTemplate.count(),
      prisma.journalEntry.count(),
      prisma.journalLine.count(),
      prisma.salesOrder.count(),
      prisma.purchaseOrder.count(),
      prisma.invoice.count(),
      prisma.bill.count(),
      prisma.payment.count(),
      prisma.shipment.count(),
      prisma.goodsReceipt.count(),
      prisma.stockTransfer.count(),
      prisma.stockAdjustment.count(),
      prisma.salesOrderLine.count(),
      prisma.purchaseOrderLine.count(),
    ]);

    res.json({
      /** Which database is actually behind this instance. */
      database: (process.env.DATABASE_URL ?? "").startsWith("postgres")
        ? "PostgreSQL"
        : "SQLite",
      /**
       * Read from the schema file rather than typed here, so adding a model
       * makes the page report a mismatch instead of quietly under-describing
       * itself. The About page compares this against what it renders.
       */
      tableCount: countModelsInSchema(),
      groups: [
        {
          name: "Catalogs",
          blurb:
            "Master data every transaction references. Records in use are archived, never deleted, so history stays readable.",
          entities: [
            { name: "Product", rows: products, note: "SKU, barcode, dimensions, default cost and price" },
            { name: "ProductCategory", rows: categories, note: "Two levels only: parent → subcategory" },
            { name: "Warehouse", rows: warehouses, note: "Stock is held at warehouse level; no bins yet" },
            { name: "Customer", rows: customers },
            { name: "Vendor", rows: vendors },
            { name: "Employee", rows: employees, note: "Managers, for reporting by owner" },
          ],
        },
        {
          name: "Stock position",
          blurb:
            "What is on hand right now, and the immutable record of how it got there.",
          entities: [
            {
              name: "InventoryBalance",
              rows: balances,
              note: "One row per [product, warehouse]: onHand, reserved, incoming",
            },
            {
              name: "InventoryMovement",
              rows: movements,
              note: "Append-only audit trail — every physical stock change",
            },
          ],
        },
        {
          name: "FIFO costing",
          blurb:
            "A quantity cannot answer what stock cost. Layers can, and they record exactly which units were consumed.",
          entities: [
            {
              name: "InventoryLot",
              rows: lots,
              note: "One receipt at a known unit cost, with a remaining quantity",
            },
            {
              name: "LotConsumption",
              rows: consumptions,
              note: "Which layers an issue drew from, and at what cost",
            },
          ],
        },
        {
          name: "General ledger",
          blurb:
            "Double entry. An entry that does not balance to the cent is refused, not corrected.",
          entities: [
            { name: "Account", rows: accounts, note: "Chart of accounts" },
            { name: "JournalTemplate", rows: templates, note: "The debit/credit pair per transaction type" },
            { name: "JournalEntry", rows: entries, note: "SAVED or POSTED; only POSTED affects the ledger" },
            { name: "JournalLine", rows: lines, note: "One side of an entry, in integer cents" },
          ],
        },
        {
          name: "Documents",
          blurb:
            "Each step of a workflow is its own document posting its own journal entry, rather than a side effect of a status change.",
          entities: [
            { name: "SalesOrder", rows: salesOrders, note: "Two independent status axes" },
            { name: "SalesOrderLine", rows: salesOrderLines, note: "Each line names its own warehouse and unit price" },
            { name: "Invoice", rows: invoices, note: "Dr Accounts Receivable / Cr Sales Revenue" },
            { name: "Shipment", rows: shipments, note: "Consumes FIFO layers, books COGS" },
            { name: "PurchaseOrder", rows: purchaseOrders, note: "Saved → Posted → Paid → Delivered" },
            { name: "PurchaseOrderLine", rows: purchaseOrderLines, note: "Unit cost here becomes the cost layer on receipt" },
            { name: "Bill", rows: bills, note: "Dr Prepaid Inventory / Cr Accounts Payable" },
            { name: "GoodsReceipt", rows: receipts, note: "Creates the cost layers" },
            { name: "Payment", rows: payments, note: "Receipt from a customer, or disbursement to a vendor" },
          ],
        },
        {
          name: "Stock operations",
          blurb: "Moving and correcting stock outside the order flows.",
          entities: [
            { name: "StockTransfer", rows: transfers, note: "Cost and FIFO age travel with the goods" },
            { name: "StockAdjustment", rows: adjustments, note: "Mandatory reason; valued at FIFO cost on a decrease" },
          ],
        },
      ],
      vocabularies: {
        movementTypes: MOVEMENT_TYPES,
        salesReadiness: READINESS_STATUSES,
        salesPayment: SO_PAYMENT_STATUSES,
        purchaseOrder: PURCHASE_ORDER_STATUSES,
        transfer: TRANSFER_STATUSES,
        adjustment: ADJUSTMENT_TYPES,
      },
    });
  })
);
