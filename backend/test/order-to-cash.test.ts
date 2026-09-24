/**
 * Order to cash across channels, exercised over HTTP and proved in the ledger.
 *
 * A Shopify order is paid at checkout, a wholesale order on net terms, and a
 * showroom client pays at the counter and walks out with the goods. Whatever
 * the path, revenue must land when the goods ship, and every liability the
 * money passed through must come back to zero. Each assertion reads the books
 * through the trial balance, not the database, because that is what an
 * accountant would read.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { as, boot, prisma } from "./helpers";
import { ACCOUNT } from "../src/accounts";

let app: Express;
let token: string;
let warehouseId: number;
let customerId: number;
let sku = 0;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "O2C WH", code: "O2CWH" } })).id;
  customerId = (await prisma.customer.create({ data: { name: "O2C Customer" } })).id;
});

/** A product with `qty` units on hand, received through the real opening path. */
async function stocked(qty: number, cost = 1_000, price = 2_500) {
  sku += 1;
  const product = await prisma.product.create({
    data: { sku: `O2C-${sku}`, name: `O2C ${sku}`, brand: "XAG", defaultCostCents: cost, defaultPriceCents: price },
  });
  const res = await as(app, token)
    .post("/api/stock-adjustments")
    .send({ productId: product.id, warehouseId, adjustmentType: "INCREASE", quantity: qty, reason: "opening", unitCostCents: cost });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return product.id;
}

async function balance(code: string) {
  const tb = await as(app, token).get("/api/trial-balance");
  return tb.body.accounts.find((a: { code: string }) => a.code === code)?.balanceCents ?? 0;
}

async function order(channel: string, productId: number, quantity = 2) {
  const res = await as(app, token)
    .post("/api/sales-orders")
    .send({ customerId, channel, lines: [{ productId, warehouseId, quantity }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; totalCents: number };
}

describe("prepaid channel (Shopify)", () => {
  it("checkout money is a deposit until the order ships, then it settles the invoice", async () => {
    const api = as(app, token);
    const productId = await stocked(5);
    const o = await order("SHOPIFY", productId);
    const revenueBefore = await balance(ACCOUNT.SALES_REVENUE);
    const depositsBefore = await balance(ACCOUNT.CUSTOMER_DEPOSITS);

    const paid = await api.post(`/api/sales-orders/${o.id}/pay`).send({ method: "CARD" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.order.paymentStatus).toBe("PREPAID");
    // Paid, but nothing sold yet.
    expect(await balance(ACCOUNT.SALES_REVENUE)).toBe(revenueBefore);
    expect(await balance(ACCOUNT.CUSTOMER_DEPOSITS)).toBe(depositsBefore + o.totalCents);

    expect((await api.post(`/api/sales-orders/${o.id}/pack`)).status).toBe(200);
    const shipped = await api.post(`/api/sales-orders/${o.id}/ship`).send({});
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(shipped.body.order.paymentStatus).toBe("PAID");
    expect(shipped.body.order.invoices).toHaveLength(1);

    expect(await balance(ACCOUNT.SALES_REVENUE)).toBe(revenueBefore + o.totalCents);
    expect(await balance(ACCOUNT.CUSTOMER_DEPOSITS)).toBe(depositsBefore);
  });

  it("an order holding a checkout payment cannot be cancelled around it", async () => {
    const api = as(app, token);
    const o = await order("SHOPIFY", await stocked(3), 1);
    await api.post(`/api/sales-orders/${o.id}/pay`).send({});
    const cancel = await api.post(`/api/sales-orders/${o.id}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.details?.action).toBe("reverse-payment");

    const reversed = await api.post(`/api/sales-orders/${o.id}/reverse-payment`).send({ reason: "customer cancelled" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.order.paymentStatus).toBe("AWAITING_PAYMENT");
    expect((await api.post(`/api/sales-orders/${o.id}/cancel`)).status).toBe(200);
  });

  it("reversing a deposit already applied to its invoice unwinds both legs", async () => {
    const api = as(app, token);
    const o = await order("AMAZON", await stocked(3), 1);
    const depositsBefore = await balance(ACCOUNT.CUSTOMER_DEPOSITS);
    const arBefore = await balance(ACCOUNT.ACCOUNTS_RECEIVABLE);
    await api.post(`/api/sales-orders/${o.id}/pay`).send({});
    await api.post(`/api/sales-orders/${o.id}/pack`);
    await api.post(`/api/sales-orders/${o.id}/ship`).send({});

    const reversed = await api.post(`/api/sales-orders/${o.id}/reverse-payment`).send({ reason: "chargeback" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.order.paymentStatus).toBe("INVOICED");
    // Deposits back to where they were; the receivable is now genuinely owed.
    expect(await balance(ACCOUNT.CUSTOMER_DEPOSITS)).toBe(depositsBefore);
    expect(await balance(ACCOUNT.ACCOUNTS_RECEIVABLE)).toBe(arBefore + o.totalCents);
  });
});

describe("terms channel (wholesale)", () => {
  it("shipping raises the invoice with the channel's due date; delivery is tracked on the order", async () => {
    const api = as(app, token);
    const o = await order("WHOLESALE", await stocked(4));
    await api.post(`/api/sales-orders/${o.id}/pack`);
    const shipped = await api.post(`/api/sales-orders/${o.id}/ship`).send({});
    expect(shipped.status).toBe(200);
    expect(shipped.body.order.paymentStatus).toBe("INVOICED");
    const invoice = shipped.body.order.invoices[0];
    const days = (new Date(invoice.dueDate).getTime() - new Date(invoice.issueDate).getTime()) / 86_400_000;
    expect(days).toBe(30);

    const shipmentId = shipped.body.shipment.id;
    const delivered = await api.post(`/api/sales-orders/shipments/${shipmentId}/tracking`).send({ delivered: true });
    expect(delivered.status).toBe(200);
    expect((await api.get(`/api/sales-orders/${o.id}`)).body.readinessStatus).toBe("DELIVERED");

    await api.post(`/api/sales-orders/shipments/${shipmentId}/tracking`).send({ delivered: false });
    expect((await api.get(`/api/sales-orders/${o.id}`)).body.readinessStatus).toBe("SHIPPED");

    const paid = await api.post(`/api/sales-orders/${o.id}/pay`).send({});
    expect(paid.body.order.paymentStatus).toBe("PAID");
  });

  it("refuses a channel it does not know", async () => {
    const productId = await stocked(1);
    const res = await as(app, token)
      .post("/api/sales-orders")
      .send({ customerId, channel: "EBAY", lines: [{ productId, warehouseId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe("showroom counter sale", () => {
  it("one request: paid, stock out, costed, invoiced, delivered — and the invoice PDF renders", async () => {
    const api = as(app, token);
    const productId = await stocked(2, 1_000, 4_000);
    const revenueBefore = await balance(ACCOUNT.SALES_REVENUE);
    const depositsBefore = await balance(ACCOUNT.CUSTOMER_DEPOSITS);

    const res = await api.post("/api/sales-orders/counter-sale").send({
      client: { name: "Showroom Visitor", email: "visitor@example.com" },
      method: "CARD",
      lines: [{ productId, warehouseId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.order.channel).toBe("SHOWROOM");
    expect(res.body.order.readinessStatus).toBe("DELIVERED");
    expect(res.body.order.paymentStatus).toBe("PAID");
    expect(res.body.order.customerName).toBe("Showroom Visitor");

    expect(await balance(ACCOUNT.SALES_REVENUE)).toBe(revenueBefore + 4_000);
    expect(await balance(ACCOUNT.CUSTOMER_DEPOSITS)).toBe(depositsBefore);
    const stock = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId, warehouseId } });
    expect(stock.onHandQty).toBe(1);
    expect(stock.reservedQty).toBe(0);

    const pdf = await api.get(`/api/sales-orders/invoices/${res.body.invoice.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/pdf/);

    // What a plain <a href> sends: no session header. This is why the UI
    // fetches PDFs through openPdf() instead of linking to them.
    const bare = await request(app).get(`/api/sales-orders/invoices/${res.body.invoice.id}/pdf`);
    expect(bare.status).toBe(401);
  });

  it("a sale beyond the shelf fails whole — no order, no payment left behind", async () => {
    const productId = await stocked(1);
    const ordersBefore = await prisma.salesOrder.count();
    const paymentsBefore = await prisma.payment.count();
    const res = await as(app, token).post("/api/sales-orders/counter-sale").send({
      lines: [{ productId, warehouseId, quantity: 5 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.salesOrder.count()).toBe(ordersBefore);
    expect(await prisma.payment.count()).toBe(paymentsBefore);
  });
});

describe("the close rulebook sees the order-to-cash gaps", () => {
  it("an order that shipped with no invoice blocks the month", async () => {
    const api = as(app, token);
    const productId = await stocked(2);
    // Named, not a catalog customer: it can ship but cannot be invoiced.
    const created = await api
      .post("/api/sales-orders")
      .send({ customerName: "Cash buyer", channel: "DIRECT", lines: [{ productId, warehouseId, quantity: 1 }] });
    await api.post(`/api/sales-orders/${created.body.id}/pack`);
    const shipped = await api.post(`/api/sales-orders/${created.body.id}/ship`).send({});
    expect(shipped.status).toBe(200);
    expect(shipped.body.order.invoices).toHaveLength(0);

    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const report = await api.get(`/api/close/${period}`);
    const check = report.body.checks.find((c: { id: string }) => c.id === "shipped-invoiced");
    expect(check.passed).toBe(false);
    expect(check.blocking).toBe(true);
    expect(check.findings.map((f: { title: string }) => f.title).join()).toMatch(/shipped with no invoice/);
  });
});

