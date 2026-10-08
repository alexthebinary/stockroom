import type { Tx } from "./db";
import { createItem } from "./routes/catalog";

/**
 * The smallest data set that still lets an admin try every step of the
 * purchase cycle at a brand-new company: one warehouse, one supplier, one
 * freight carrier and three items. No stock and no transactions — the admin
 * makes the first PO, scan, bill and payment themselves.
 *
 * The barcodes are valid GS1 check digits in the 0-12345 demonstration range,
 * printed on the in-app test sheet so a phone can scan them off a screen.
 */
export const SAMPLE = {
  warehouse: { code: "MAIN", name: "Main warehouse" },
  supplier: { name: "Sample Supplier Co.", kind: "SUPPLIER", paymentTermsDays: 30, email: "orders@sample-supplier.example" },
  carrier: { name: "Sample Freight Lines", kind: "CARRIER", paymentTermsDays: 15, email: "billing@sample-freight.example" },
  widget: { sku: "SAMPLE-WIDGET", name: "Sample Widget", barcode: "012345678905", vendorSku: "SS-100", costCents: 50000 },
  robot: { sku: "SAMPLE-ROBOT", name: "Sample Robot (serial-tracked)", barcode: "012345678912", vendorSku: "SS-200", costCents: 120000 },
  openBox: { sku: "SAMPLE-WIDGET-OB", name: "Sample Widget — open box", barcode: "SAMPLE-WIDGET-OB" },
  serials: ["SN-0001", "SN-0002"],
} as const;

export async function loadSampleData(tx: Tx) {
  await tx.warehouse.create({ data: { ...SAMPLE.warehouse, isSample: true } });
  const supplier = await tx.vendor.create({ data: { ...SAMPLE.supplier, isSample: true } });
  await tx.vendor.create({ data: { ...SAMPLE.carrier, isSample: true } });
  const widget = await createItem(tx, {
    sku: SAMPLE.widget.sku,
    name: SAMPLE.widget.name,
    trackingMode: "NONE",
    condition: "NEW",
    defaultVendorId: supplier.id,
    lastCostCents: SAMPLE.widget.costCents,
    barcodes: [{ raw: SAMPLE.widget.barcode, packQty: 1 }],
    vendorItems: [{ vendorId: supplier.id, vendorSku: SAMPLE.widget.vendorSku, lastCostCents: SAMPLE.widget.costCents }],
    isSample: true,
  });
  await createItem(tx, {
    sku: SAMPLE.robot.sku,
    name: SAMPLE.robot.name,
    trackingMode: "SERIAL",
    condition: "NEW",
    defaultVendorId: supplier.id,
    lastCostCents: SAMPLE.robot.costCents,
    barcodes: [{ raw: SAMPLE.robot.barcode, packQty: 1 }],
    vendorItems: [{ vendorId: supplier.id, vendorSku: SAMPLE.robot.vendorSku, lastCostCents: SAMPLE.robot.costCents }],
    isSample: true,
  });
  await createItem(tx, {
    sku: SAMPLE.openBox.sku,
    name: SAMPLE.openBox.name,
    trackingMode: "NONE",
    condition: "OPEN_BOX",
    conditionOfId: widget.id,
    lastCostCents: 0,
    barcodes: [{ raw: SAMPLE.openBox.barcode, packQty: 1 }],
    vendorItems: [],
    isSample: true,
  });
}

/** Only while nothing real has happened: no entries, no orders, no scans. */
export async function clearSampleData(tx: Tx) {
  const sampleItems = (await tx.item.findMany({ where: { isSample: true }, select: { id: true } })).map((i) => i.id);
  await tx.itemBarcode.deleteMany({ where: { itemId: { in: sampleItems } } });
  await tx.vendorItem.deleteMany({ where: { itemId: { in: sampleItems } } });
  await tx.item.updateMany({ where: { isSample: true }, data: { conditionOfId: null } });
  await tx.item.deleteMany({ where: { isSample: true } });
  await tx.vendor.deleteMany({ where: { isSample: true } });
  await tx.warehouse.deleteMany({ where: { isSample: true } });
}
