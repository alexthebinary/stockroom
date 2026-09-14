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
