import PDFDocument from "pdfkit";
import type { Response } from "express";

/**
 * Document rendering.
 *
 * pdfkit rather than headless Chrome. Chrome would let the print stylesheet do
 * the layout, but it adds roughly 300 MB of Chromium to an image that currently
 * runs on a free instance, and a PDF a customer receives should not depend on a
 * browser rendering the same way twice. pdfkit draws to the page directly: no
 * browser, about 11 MB, and the output is identical on every host.
 *
 * Laid out for North America — US Letter, $ totals, no UBL or Peppol envelope.
 * Those are European e-invoicing standards and carry real obligations; if the
 * market ever changes, this is the file that changes with it.
 */

const PAGE = { size: "LETTER" as const, margin: 54 }; // 0.75in
const INK = "#0b1b30";
const MUTED = "#6b7d93";
const RULE = "#c6cfdb";
const ACCENT = "#2a5fd4";

const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

const day = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

export type InvoiceForPdf = {
  invoiceNumber: string;
  issueDate: Date | string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  status: string;
  customer: { name: string; email?: string | null; phone?: string | null; address?: string | null };
  salesOrder?: {
    orderNumber: string;
    lines: {
      quantity: number;
      unitPriceCents: number;
      lineTotalCents: number;
      product: { sku: string; name: string };
    }[];
  } | null;
  amountPaidCents: number;
};

/**
 * Stream an invoice as a PDF.
 *
 * Streamed rather than buffered: a document is written to the socket as it is
 * drawn, so memory does not scale with the size of the order.
 */
export function renderInvoice(res: Response, invoice: InvoiceForPdf, company: CompanyDetails) {
  const doc = new PDFDocument({ ...PAGE, info: { Title: `Invoice ${invoice.invoiceNumber}` } });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${invoice.invoiceNumber}.pdf"`
  );
  doc.pipe(res);

  const left = PAGE.margin;
  const right = doc.page.width - PAGE.margin;
  const width = right - left;

  // ---- masthead ------------------------------------------------------------
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(company.name, left, PAGE.margin);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  company.address.split("\n").forEach((line) => doc.text(line, { width: 240 }));

  doc.font("Helvetica-Bold").fontSize(24).fillColor(INK)
     .text("INVOICE", left, PAGE.margin, { width, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
     .text(invoice.invoiceNumber, { width, align: "right" });
  let headerBottom = doc.y;

  // A void invoice that looks exactly like a live one is a document that can be
  // paid twice. Say so, unmissably, before anything else on the page.
  if (invoice.status === "VOID") {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#b42318")
       .text("VOID — NOT PAYABLE", { width, align: "right" });
    headerBottom = doc.y;
  }

  // Follow the taller of the two header columns rather than a fixed floor: a
  // short address left a band of empty page under the masthead.
  let y = Math.max(doc.y, headerBottom) + 16;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 18;

  // ---- parties and dates ---------------------------------------------------
  const colRight = left + width * 0.62;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("BILL TO", left, y);
  doc.font("Helvetica").fontSize(10).fillColor(INK).text(invoice.customer.name, left, y + 13, { width: width * 0.55 });
  const contact = [invoice.customer.address, invoice.customer.email, invoice.customer.phone]
    .filter(Boolean).join("\n");
  if (contact) doc.fontSize(9).fillColor(MUTED).text(contact, { width: width * 0.55 });

  const facts: [string, string][] = [
    ["Issued", day(invoice.issueDate)],
    ...(invoice.salesOrder ? ([["Order", invoice.salesOrder.orderNumber]] as [string, string][]) : []),
    ["Currency", invoice.currency],
  ];
  let fy = y;
  for (const [label, value] of facts) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), colRight, fy);
    doc.font("Helvetica").fontSize(10).fillColor(INK).text(value, colRight, fy + 11);
    fy += 30;
  }

  y = Math.max(doc.y, fy) + 14;

  // ---- lines ---------------------------------------------------------------
  const cols = { sku: left, desc: left + 88, qty: right - 190, unit: right - 130, total: right - 62 };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
  doc.text("SKU", cols.sku, y);
  doc.text("DESCRIPTION", cols.desc, y);
  doc.text("QTY", cols.qty, y, { width: 46, align: "right" });
  doc.text("UNIT", cols.unit, y, { width: 56, align: "right" });
  doc.text("AMOUNT", cols.total, y, { width: 62, align: "right" });
  y += 14;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 9;

  const lines = invoice.salesOrder?.lines ?? [];
  for (const line of lines) {
    // A line that would be cut in half by the page edge is worse than a page
    // break, so break first and redraw nothing — the totals carry the meaning.
    if (y > doc.page.height - PAGE.margin - 120) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(line.product.sku, cols.sku, y, { width: 84 });
    doc.fillColor(INK).text(line.product.name, cols.desc, y, { width: cols.qty - cols.desc - 12 });
    const rowBottom = doc.y;
    doc.fillColor(INK)
       .text(String(line.quantity), cols.qty, y, { width: 46, align: "right" })
       .text(money(line.unitPriceCents, invoice.currency), cols.unit, y, { width: 56, align: "right" })
       .text(money(line.lineTotalCents, invoice.currency), cols.total, y, { width: 62, align: "right" });
    y = Math.max(rowBottom, doc.y) + 7;
  }

  if (lines.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
       .text("This invoice has no lines.", cols.sku, y);
    y = doc.y + 7;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 12;

  // ---- totals --------------------------------------------------------------
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10)
       .fillColor(bold ? INK : MUTED)
       .text(label, cols.unit - 110, y, { width: 150, align: "right" });
    doc.fillColor(INK).text(value, cols.total - 46, y, { width: 108, align: "right" });
    y += bold ? 18 : 15;
  };

  totalRow("Subtotal", money(invoice.subtotalCents, invoice.currency));
  if (invoice.taxCents) totalRow("Tax", money(invoice.taxCents, invoice.currency));
  if (invoice.shippingCents) totalRow("Shipping", money(invoice.shippingCents, invoice.currency));

  doc.moveTo(cols.unit - 110 + 40, y + 2).lineTo(right, y + 2).lineWidth(1).strokeColor(RULE).stroke();
  y += 10;
  totalRow("Total", money(invoice.totalCents, invoice.currency), true);

  // What is actually owed is the number the customer needs, and it is not the
  // total once anything has been paid against it.
  if (invoice.amountPaidCents > 0) {
    totalRow("Paid", `-${money(invoice.amountPaidCents, invoice.currency)}`);
    const due = invoice.totalCents - invoice.amountPaidCents;
    doc.font("Helvetica-Bold").fontSize(11)
       .fillColor(due > 0 ? ACCENT : "#067647")
       .text(due > 0 ? "Balance due" : "Paid in full", cols.unit - 110, y, { width: 150, align: "right" })
       .text(money(Math.max(due, 0), invoice.currency), cols.total - 46, y, { width: 108, align: "right" });
    y += 18;
  }

  // ---- footer --------------------------------------------------------------
  const footerY = doc.page.height - PAGE.margin - 26;
  doc.moveTo(left, footerY - 10).lineTo(right, footerY - 10).lineWidth(1).strokeColor(RULE).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text(company.footer, left, footerY, { width, align: "center" });

  doc.end();
}

export type CompanyDetails = { name: string; address: string; footer: string };

/**
 * Whose name is on the document.
 *
 * Environment-driven because it is per-deployment, not per-record, and because
 * a demo shipping somebody else's letterhead is worse than a plain one.
 */
export function companyDetails(): CompanyDetails {
  return {
    name: process.env.COMPANY_NAME ?? "Stockroom",
    address: process.env.COMPANY_ADDRESS ?? "Inventory demo\nNo registered address",
    footer:
      process.env.COMPANY_FOOTER ??
      "Generated by Stockroom. This document is a demonstration and is not a request for payment.",
  };
}

// ---------------------------------------------------------------------------
// Shipment documents
// ---------------------------------------------------------------------------

/**
 * Code 128B, drawn as rectangles.
 *
 * A dependency for this would be ~1 MB to draw black bars, and the symbology is
 * a fixed table plus a modulo-103 checksum. Subset B only: it covers every
 * printable ASCII character, which is every character a document number here
 * can contain. Subset C would halve the width of an all-digit number, and is
 * not worth a second code path for a number that already fits.
 *
 * The app's own scanner already reads `code_128` (LabelScanner), so a label
 * printed here round-trips through the camera it was built for.
 */
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Module widths, alternating bar/space and always starting on a bar. */
export function code128bModules(value: string): number[] {
  // Anything outside the printable range cannot be encoded in subset B. Dropping
  // it beats throwing: a label with a slightly shortened number still ships, and
  // every number this system generates is already A-Z0-9 and a hyphen.
  const chars = [...value].filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code <= 126;
  });

  const codes = [CODE128_START_B, ...chars.map((c) => c.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103;

  return [...codes, checksum, CODE128_STOP]
    .flatMap((code) => [...CODE128_PATTERNS[code]].map(Number));
}

/**
 * Draw a barcode that fits `width`, or as much of it as the quiet zones allow.
 *
 * Returns the width actually drawn, which is <= `width`: module width is
 * rounded DOWN to a whole number of points. A fractional module renders as a
 * blurred edge on a thermal printer and is the usual reason a label that looks
 * fine on screen will not scan.
 */
function drawBarcode(
  doc: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number
) {
  const modules = code128bModules(value);
  const totalModules = modules.reduce((a, b) => a + b, 0);
  const moduleWidth = Math.max(1, Math.floor((width / totalModules) * 100) / 100);
  const drawn = totalModules * moduleWidth;

  let cursor = x + (width - drawn) / 2;
  modules.forEach((widthInModules, i) => {
    const barWidth = widthInModules * moduleWidth;
    // Even indices are bars, odd are spaces.
    if (i % 2 === 0) doc.rect(cursor, y, barWidth, height).fill(INK);
    cursor += barWidth;
  });

  return drawn;
}

export type ShipmentForPdf = {
  shipmentNumber: string;
  shippedAt: Date | string;
  carrier?: string | null;
  trackingNumber?: string | null;
  deliveredAt?: Date | string | null;
  status: string;
  warehouse?: { name: string; code: string; address?: string | null } | null;
  salesOrder: {
    orderNumber: string;
    customerName: string;
    notes?: string | null;
    customer?: {
      name: string;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
    } | null;
    lines: {
      quantity: number;
      product: { sku: string; name: string };
      warehouse?: { name: string } | null;
    }[];
  };
};

/** Ship-to, as the best address we hold. The catalog wins over the typed name. */
function shipTo(shipment: ShipmentForPdf) {
  const customer = shipment.salesOrder.customer;
  const name = customer?.name ?? shipment.salesOrder.customerName;
  const rest = [customer?.address, customer?.phone].filter(Boolean) as string[];
  return { name, rest };
}

/**
 * The document that goes IN the box.
 *
 * Deliberately carries no prices. A packing slip is checked by whoever opens
 * the carton, and that is regularly not the person who agreed the price —
 * dropshippers and gift orders both break when the cost is in the box.
 */
export function renderPackingSlip(
  res: Response,
  shipment: ShipmentForPdf,
  company: CompanyDetails
) {
  const doc = new PDFDocument({
    ...PAGE,
    info: { Title: `Packing slip ${shipment.shipmentNumber}` },
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${shipment.shipmentNumber}-packing-slip.pdf"`
  );
  doc.pipe(res);

  const left = PAGE.margin;
  const right = doc.page.width - PAGE.margin;
  const width = right - left;

  // ---- header --------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(company.name, left, PAGE.margin);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
     .text(company.address, left, doc.y + 2, { width: width * 0.5 });

  doc.font("Helvetica-Bold").fontSize(20).fillColor(ACCENT)
     .text("PACKING SLIP", left, PAGE.margin, { width, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
     .text(shipment.shipmentNumber, left, doc.y + 2, { width, align: "right" });

  let y = Math.max(doc.y, PAGE.margin + 64) + 18;

  // ---- ship to / details ---------------------------------------------------
  const to = shipTo(shipment);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("SHIP TO", left, y);
  doc.font("Helvetica").fontSize(11).fillColor(INK).text(to.name, left, y + 13, { width: width * 0.5 });
  if (to.rest.length) {
    doc.fontSize(9).fillColor(MUTED)
       .text(to.rest.join("\n"), left, doc.y + 2, { width: width * 0.5 });
  }

  const details: [string, string][] = [
    ["Order", shipment.salesOrder.orderNumber],
    ["Shipped", day(shipment.shippedAt)],
    ...(shipment.warehouse
      ? ([["From", `${shipment.warehouse.name} (${shipment.warehouse.code})`]] as [string, string][])
      : []),
    ...(shipment.carrier ? ([["Carrier", shipment.carrier]] as [string, string][]) : []),
    ...(shipment.trackingNumber
      ? ([["Tracking", shipment.trackingNumber]] as [string, string][])
      : []),
  ];
  let detailY = y;
  for (const [label, value] of details) {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
       .text(label, left + width * 0.6, detailY, { width: width * 0.15 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
       .text(value, left + width * 0.75, detailY, { width: width * 0.25, align: "right" });
    detailY += 14;
  }

  y = Math.max(doc.y, detailY) + 20;

  // ---- lines ---------------------------------------------------------------
  const cols = { sku: left, name: left + 110, from: right - 170, qty: right - 50 };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
     .text("SKU", cols.sku, y)
     .text("ITEM", cols.name, y)
     .text("FROM", cols.from, y, { width: 110 })
     .text("QTY", cols.qty, y, { width: 50, align: "right" });
  y += 13;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 9;

  const lines = shipment.salesOrder.lines;
  if (!lines.length) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
       .text("This shipment has no lines.", cols.sku, y);
    y += 16;
  }
  for (const line of lines) {
    // A page break mid-carton is worse than a second page, so break early.
    if (y > doc.page.height - PAGE.margin - 90) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.font("Helvetica").fontSize(9).fillColor(INK)
       .text(line.product.sku, cols.sku, y, { width: 105 })
       .text(line.product.name, cols.name, y, { width: cols.from - cols.name - 10 })
       .text(line.warehouse?.name ?? "—", cols.from, y, { width: 110 })
       .font("Helvetica-Bold")
       .text(String(line.quantity), cols.qty, y, { width: 50, align: "right" });
    y = doc.y + 7;
  }

  // ---- checked-by ----------------------------------------------------------
  y += 14;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 16;
  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
     .text(`${totalUnits} unit${totalUnits === 1 ? "" : "s"} in ${lines.length} line${lines.length === 1 ? "" : "s"}`, left, y);

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text("Packed by", left + width * 0.6, y, { width: width * 0.4 });
  doc.moveTo(left + width * 0.6, y + 26).lineTo(right, y + 26)
     .lineWidth(1).strokeColor(RULE).stroke();

  if (shipment.salesOrder.notes) {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
       .text("Order notes", left, y + 42)
       .fillColor(INK).fontSize(9)
       .text(shipment.salesOrder.notes, left, y + 54, { width: width * 0.55 });
  }

  // ---- barcode -------------------------------------------------------------
  const barcodeY = doc.page.height - PAGE.margin - 58;
  drawBarcode(doc, shipment.shipmentNumber, left, barcodeY, 180, 34);
  doc.font("Courier").fontSize(9).fillColor(INK)
     .text(shipment.shipmentNumber, left, barcodeY + 38, { width: 180, align: "center" });

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text(company.footer, left + width * 0.45, barcodeY + 20, { width: width * 0.55, align: "right" });

  doc.end();
}

/**
 * The 4x6 label that goes ON the box.
 *
 * This is NOT carrier postage — Stockroom buys nothing and validates nothing
 * (see carriers.ts). It is the thermal-printer label a warehouse puts on a
 * carton so the parcel can be identified on a shelf and on a van; where a
 * carrier is involved, their own scannable label goes on next to it.
 *
 * 4x6in at 72pt/in, no margin — thermal stock is exactly the page.
 */
export function renderAddressLabel(
  res: Response,
  shipment: ShipmentForPdf,
  company: CompanyDetails
) {
  const W = 288; // 4in
  const H = 432; // 6in
  const PAD = 16;

  const doc = new PDFDocument({
    size: [W, H],
    margin: 0,
    info: { Title: `Label ${shipment.shipmentNumber}` },
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${shipment.shipmentNumber}-label.pdf"`);
  doc.pipe(res);

  const inner = W - PAD * 2;

  // ---- from ----------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(7).fillColor(MUTED).text("FROM", PAD, PAD);
  doc.font("Helvetica").fontSize(8).fillColor(INK)
     .text(company.name, PAD, PAD + 10, { width: inner });
  const fromAddress = shipment.warehouse?.address ?? company.address;
  doc.fontSize(7).fillColor(MUTED).text(fromAddress, PAD, doc.y, { width: inner });

  let y = doc.y + 12;
  doc.moveTo(PAD, y).lineTo(W - PAD, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 16;

  // ---- to ------------------------------------------------------------------
  const to = shipTo(shipment);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(MUTED).text("SHIP TO", PAD, y);
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK)
     .text(to.name, PAD, y + 12, { width: inner });
  if (to.rest.length) {
    doc.font("Helvetica").fontSize(11).fillColor(INK)
       .text(to.rest.join("\n"), PAD, doc.y + 4, { width: inner });
  } else {
    // An address we do not hold is stated, not left blank — a blank block on a
    // label reads as a printer fault and gets reprinted rather than fixed.
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
       .text("No address on file for this customer.", PAD, doc.y + 4, { width: inner });
  }

  y = doc.y + 14;
  doc.moveTo(PAD, y).lineTo(W - PAD, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 12;

  // ---- carrier -------------------------------------------------------------
  if (shipment.carrier || shipment.trackingNumber) {
    doc.font("Helvetica-Bold").fontSize(7).fillColor(MUTED).text("CARRIER", PAD, y);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
       .text(shipment.carrier ?? "—", PAD, y + 10, { width: inner });
    if (shipment.trackingNumber) {
      doc.font("Courier").fontSize(9).fillColor(INK)
         .text(shipment.trackingNumber, PAD, doc.y + 2, { width: inner });
    }
    y = doc.y + 12;
  }

  // ---- order ---------------------------------------------------------------
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text(`Order ${shipment.salesOrder.orderNumber}  ·  ${day(shipment.shippedAt)}`, PAD, y, {
       width: inner,
     });

  // ---- barcode, pinned to the bottom --------------------------------------
  const barcodeHeight = 56;
  const barcodeY = H - PAD - barcodeHeight - 16;
  drawBarcode(doc, shipment.shipmentNumber, PAD, barcodeY, inner, barcodeHeight);
  doc.font("Courier-Bold").fontSize(11).fillColor(INK)
     .text(shipment.shipmentNumber, PAD, barcodeY + barcodeHeight + 4, {
       width: inner,
       align: "center",
     });

  doc.end();
}

export type GoodsReceiptForPdf = {
  grnNumber: string;
  receivedAt: Date | string;
  status: string;
  totalCostCents: number;
  warehouse?: { name: string; code: string; address?: string | null } | null;
  purchaseOrder: {
    poNumber: string;
    supplierName: string;
    vendor?: { name: string; email?: string | null; phone?: string | null } | null;
    notes?: string | null;
    lines: {
      quantity: number;
      unitCostCents: number;
      product: { sku: string; name: string };
      warehouse?: { name: string; code: string } | null;
    }[];
  };
};

/**
 * The goods receipt note — signed on the dock, filed against the vendor's own
 * delivery note.
 *
 * Carries landed cost, unlike the outbound packing slip which deliberately
 * carries none. This document faces inward: the person checking a pallet in is
 * the person who needs to know what it cost, and posting this receipt is what
 * created the FIFO layers those numbers came from.
 */
export function renderGoodsReceipt(
  res: Response,
  grn: GoodsReceiptForPdf,
  company: CompanyDetails
) {
  const doc = new PDFDocument({ ...PAGE, info: { Title: `Goods receipt ${grn.grnNumber}` } });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${grn.grnNumber}.pdf"`);
  doc.pipe(res);

  const left = PAGE.margin;
  const right = doc.page.width - PAGE.margin;
  const width = right - left;

  // ---- header --------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(company.name, left, PAGE.margin);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
     .text(company.address, left, doc.y + 2, { width: width * 0.5 });

  doc.font("Helvetica-Bold").fontSize(20).fillColor(ACCENT)
     .text("GOODS RECEIPT", left, PAGE.margin, { width, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
     .text(grn.grnNumber, left, doc.y + 2, { width, align: "right" });

  let y = Math.max(doc.y, PAGE.margin + 64) + 18;

  // ---- received from / details --------------------------------------------
  const supplier = grn.purchaseOrder.vendor?.name ?? grn.purchaseOrder.supplierName;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("RECEIVED FROM", left, y);
  doc.font("Helvetica").fontSize(11).fillColor(INK).text(supplier, left, y + 13, { width: width * 0.5 });
  const contact = [grn.purchaseOrder.vendor?.email, grn.purchaseOrder.vendor?.phone]
    .filter(Boolean).join("  ·  ");
  if (contact) {
    doc.fontSize(9).fillColor(MUTED).text(contact, left, doc.y + 2, { width: width * 0.5 });
  }

  const details: [string, string][] = [
    ["Order", grn.purchaseOrder.poNumber],
    ["Received", day(grn.receivedAt)],
    ...(grn.warehouse
      ? ([["Into", `${grn.warehouse.name} (${grn.warehouse.code})`]] as [string, string][])
      : ([["Into", "Multiple warehouses"]] as [string, string][])),
  ];
  let detailY = y;
  for (const [label, value] of details) {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
       .text(label, left + width * 0.6, detailY, { width: width * 0.15 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
       .text(value, left + width * 0.75, detailY, { width: width * 0.25, align: "right" });
    detailY += 14;
  }

  y = Math.max(doc.y, detailY) + 20;

  // ---- lines ---------------------------------------------------------------
  const cols = { sku: left, name: left + 105, into: right - 200, qty: right - 118, cost: right - 62 };
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
     .text("SKU", cols.sku, y)
     .text("ITEM", cols.name, y)
     .text("INTO", cols.into, y, { width: 78 })
     .text("QTY", cols.qty, y, { width: 48, align: "right" })
     .text("COST", cols.cost, y, { width: 62, align: "right" });
  y += 13;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 9;

  const lines = grn.purchaseOrder.lines;
  if (!lines.length) {
    doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
       .text("This receipt has no lines.", cols.sku, y);
    y += 16;
  }
  for (const line of lines) {
    if (y > doc.page.height - PAGE.margin - 90) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.font("Helvetica").fontSize(9).fillColor(INK)
       .text(line.product.sku, cols.sku, y, { width: 100 })
       .text(line.product.name, cols.name, y, { width: cols.into - cols.name - 10 })
       .text(line.warehouse?.code ?? "—", cols.into, y, { width: 78 })
       .font("Helvetica-Bold")
       .text(String(line.quantity), cols.qty, y, { width: 48, align: "right" })
       .font("Helvetica")
       .text(money(line.unitCostCents * line.quantity), cols.cost, y, { width: 62, align: "right" });
    y = doc.y + 7;
  }

  // ---- totals and sign-off -------------------------------------------------
  y += 8;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
     .text(`${totalUnits} unit${totalUnits === 1 ? "" : "s"} received`, left, y);

  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
     .text("Landed cost", cols.qty - 40, y, { width: 100, align: "right" });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
     .text(money(grn.totalCostCents), cols.cost, y - 1, { width: 62, align: "right" });

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text("This is the cost the FIFO layers were created at.", left, y + 16, { width: width * 0.55 });

  // Two signatures, because a receipt nobody signed is an assertion, not a record.
  const sigY = y + 54;
  for (const [i, label] of ["Checked in by", "Driver / vendor"].entries()) {
    const x = left + i * (width / 2);
    doc.moveTo(x, sigY + 24).lineTo(x + width / 2 - 24, sigY + 24)
       .lineWidth(1).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label, x, sigY + 28);
  }

  // ---- barcode -------------------------------------------------------------
  const barcodeY = doc.page.height - PAGE.margin - 58;
  drawBarcode(doc, grn.grnNumber, left, barcodeY, 180, 34);
  doc.font("Courier").fontSize(9).fillColor(INK)
     .text(grn.grnNumber, left, barcodeY + 38, { width: 180, align: "center" });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
     .text(company.footer, left + width * 0.45, barcodeY + 20, { width: width * 0.55, align: "right" });

  doc.end();
}
