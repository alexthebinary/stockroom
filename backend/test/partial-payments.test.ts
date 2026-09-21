/**
 * Partial payment against a sales invoice.
 *
 * `/pay` used to ignore its body and always record `invoice.totalCents`, so an
 * order was either unpaid or settled in full — a deposit, a part-settlement or
 * a customer paying two invoices with one cheque had nowhere to go, and the
 * outstanding balance the invoice list computes could only ever be 0 or the
 * whole total.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";
import { createLot } from "../src/costing";

let app: Express;
let token: string;
let warehouseId: number;
let productId: number;
let customerId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Pay WH", code: "PAYWH" } })).id;
  productId = (
    await prisma.product.create({
      data: { sku: "PAY-1", name: "Payable widget", brand: "Unitree", defaultPriceCents: 10_000 },
    })
  ).id;
  customerId = (await prisma.customer.create({ data: { name: "Part Payer Inc" } })).id;
});

/** An order invoiced and awaiting money. Total is 4 x 10_000 = 40_000. */
async function invoicedOrder() {
  const api = as(app, token);

  await prisma.inventoryBalance.upsert({
    where: { productId_warehouseId: { productId, warehouseId } },
    create: { productId, warehouseId, onHandQty: 40, reservedQty: 0 },
    update: { onHandQty: { increment: 40 } },
  });
  await prisma.$transaction((tx) =>
    createLot(tx, { productId, warehouseId, quantity: 40, unitCostCents: 3_000, sourceType: "TEST" })
  );

  const created = await api.post("/api/sales-orders").send({
    customerId,
    lines: [{ productId, warehouseId, quantity: 4, unitPriceCents: 10_000 }],
  });
  expect(created.status).toBe(201);
  const orderId = created.body.id as number;

  for (const verb of ["pack", "invoice"]) {
    const res = await api.post(`/api/sales-orders/${orderId}/${verb}`);
    if (res.status >= 300) throw new Error(`${verb} failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  const detail = await api.get(`/api/sales-orders/${orderId}`);
  expect(detail.body.totalCents).toBe(40_000);
  return { orderId, api, invoiceId: detail.body.invoices[0].id as number };
}

/** Outstanding as the invoice list computes it — the number a user acts on. */
async function outstanding(api: ReturnType<typeof as>, invoiceId: number) {
  const list = await api.get("/api/sales-orders/invoices?pageSize=200");
  const row = list.body.data.find((i: any) => i.id === invoiceId);
  if (!row) throw new Error(`invoice ${invoiceId} not in the list`);
  return { outstandingCents: row.outstandingCents, amountPaidCents: row.amountPaidCents };
}

describe("partial payment", () => {
  it("records the amount asked for, not the invoice total", async () => {
    const { orderId, api, invoiceId } = await invoicedOrder();

    const paid = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 15_000 });
    expect(paid.status).toBe(201);
    expect(paid.body.payment.amountCents).toBe(15_000);

    expect(await outstanding(api, invoiceId)).toEqual({
      amountPaidCents: 15_000,
      outstandingCents: 25_000,
    });
  });

  it("leaves the order payable until the balance reaches zero", async () => {
    const { orderId, api, invoiceId } = await invoicedOrder();

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 10_000 });
    let order = await api.get(`/api/sales-orders/${orderId}`);
    expect(order.body.paymentStatus).toBe("INVOICED");

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 20_000 });
    order = await api.get(`/api/sales-orders/${orderId}`);
    expect(order.body.paymentStatus).toBe("INVOICED");
    expect((await outstanding(api, invoiceId)).outstandingCents).toBe(10_000);

    // The instalment that clears it is the one that flips the status.
    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 10_000 });
    order = await api.get(`/api/sales-orders/${orderId}`);
    expect(order.body.paymentStatus).toBe("PAID");
    expect(await outstanding(api, invoiceId)).toEqual({
      amountPaidCents: 40_000,
      outstandingCents: 0,
    });
  });

  it("posts a ledger entry for each instalment, at its own amount", async () => {
    const { orderId, api } = await invoicedOrder();

    const first = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 12_500 });
    const second = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 27_500 });

    for (const [res, amount] of [[first, 12_500], [second, 27_500]] as const) {
      const lines = await prisma.journalLine.findMany({
        where: { journalEntryId: res.body.entry.id },
      });
      const debits = lines.reduce((s, l) => s + l.debitCents, 0);
      const credits = lines.reduce((s, l) => s + l.creditCents, 0);
      expect(debits).toBe(amount);
      expect(credits).toBe(amount);
    }
  });

  it("defaults to the whole outstanding balance when no amount is given", async () => {
    // The pre-existing behaviour and every existing caller: pay with no body
    // settles the invoice.
    const { orderId, api, invoiceId } = await invoicedOrder();

    const paid = await api.post(`/api/sales-orders/${orderId}/pay`);
    expect(paid.status).toBe(201);
    expect(paid.body.payment.amountCents).toBe(40_000);
    expect((await outstanding(api, invoiceId)).outstandingCents).toBe(0);
  });

  it("defaults to what is LEFT, not the total, after a part payment", async () => {
    const { orderId, api, invoiceId } = await invoicedOrder();

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 30_000 });
    const rest = await api.post(`/api/sales-orders/${orderId}/pay`);
    expect(rest.body.payment.amountCents).toBe(10_000);
    expect((await outstanding(api, invoiceId)).outstandingCents).toBe(0);
  });

  it("refuses to take more than is owed", async () => {
    const { orderId, api } = await invoicedOrder();

    const over = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 40_001 });
    expect(over.status).toBe(400);
    expect(String(over.body.message ?? over.body.error)).toMatch(/owed|outstanding|more than/i);

    // Overpaying in instalments is the same mistake arriving more slowly.
    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 39_000 });
    const creep = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 2_000 });
    expect(creep.status).toBe(400);
  });

  it("refuses a zero or negative amount", async () => {
    const { orderId, api } = await invoicedOrder();
    expect((await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 0 })).status).toBe(400);
    expect((await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: -500 })).status).toBe(400);
  });

  it("reverses one instalment without unwinding the others", async () => {
    const { orderId, api, invoiceId } = await invoicedOrder();

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 15_000 });
    const second = await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 5_000 });
    expect((await outstanding(api, invoiceId)).amountPaidCents).toBe(20_000);

    const reversed = await api
      .post(`/api/sales-orders/${orderId}/reverse-payment`)
      .send({ reason: "keyed against the wrong customer", paymentId: second.body.payment.id });
    expect(reversed.status).toBe(200);

    // Only the named instalment goes; the first one is still money we have.
    expect(await outstanding(api, invoiceId)).toEqual({
      amountPaidCents: 15_000,
      outstandingCents: 25_000,
    });
  });

  it("can reverse a payment on a partially paid order, which is not PAID", async () => {
    // The old guard was `paymentStatus !== "PAID"`, which made a mis-keyed
    // deposit impossible to undo: the order never reached PAID in the first
    // place.
    const { orderId, api, invoiceId } = await invoicedOrder();

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 5_000 });
    const order = await api.get(`/api/sales-orders/${orderId}`);
    expect(order.body.paymentStatus).toBe("INVOICED");

    const reversed = await api
      .post(`/api/sales-orders/${orderId}/reverse-payment`)
      .send({ reason: "deposit keyed twice" });
    expect(reversed.status).toBe(200);
    expect(await outstanding(api, invoiceId)).toEqual({
      amountPaidCents: 0,
      outstandingCents: 40_000,
    });
  });

  it("returns a fully paid order to payable when its last payment is reversed", async () => {
    const { orderId, api } = await invoicedOrder();

    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 40_000 });
    expect((await api.get(`/api/sales-orders/${orderId}`)).body.paymentStatus).toBe("PAID");

    await api.post(`/api/sales-orders/${orderId}/reverse-payment`).send({ reason: "bounced" });
    expect((await api.get(`/api/sales-orders/${orderId}`)).body.paymentStatus).toBe("INVOICED");
  });

  it("splits the invoice list cleanly with a part-paid invoice in it", async () => {
    // A partly paid invoice is the case the binary filter could not produce
    // before, so it is the one that proves the filter partitions on balance
    // rather than on status.
    const { orderId, api, invoiceId } = await invoicedOrder();
    await api.post(`/api/sales-orders/${orderId}/pay`).send({ amountCents: 1_000 });

    const unpaid = await api.get("/api/sales-orders/invoices?settlement=UNPAID&pageSize=200");
    const paid = await api.get("/api/sales-orders/invoices?settlement=PAID&pageSize=200");

    expect(unpaid.body.data.some((i: any) => i.id === invoiceId)).toBe(true);
    expect(paid.body.data.some((i: any) => i.id === invoiceId)).toBe(false);
    expect(unpaid.body.data.every((i: any) => i.outstandingCents > 0)).toBe(true);
  });
});
