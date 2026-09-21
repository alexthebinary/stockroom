/**
 * Partial payment against a vendor bill — the purchases mirror of
 * partial-payments.test.ts.
 *
 * `/purchase-orders/:id/pay` had the same all-or-nothing flaw the sales side
 * did, plus one of its own: it gated on `payment.count() > 0`, so once any
 * payment existed the bill was closed forever. Paying a supplier a deposit and
 * the balance later — the normal way capital equipment is bought — was
 * impossible.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express;
let token: string;
let warehouseId: number;
let productId: number;
let vendorId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "PO Pay WH", code: "POPAY" } })).id;
  productId = (
    await prisma.product.create({
      data: { sku: "POPAY-1", name: "Payable inbound", brand: "Unitree", defaultCostCents: 100_000 },
    })
  ).id;
  vendorId = (await prisma.vendor.create({ data: { name: "Unitree Robotics (test)" } })).id;
});

/** A posted PO with a posted bill. 2 x $1000 = $2000. */
async function postedOrder() {
  const api = as(app, token);
  const created = await api.post("/api/purchase-orders").send({
    vendorId,
    lines: [{ productId, warehouseId, quantity: 2, unitCostCents: 100_000 }],
  });
  expect(created.status).toBe(201);
  const orderId = created.body.id as number;

  const posted = await api.post(`/api/purchase-orders/${orderId}/post`);
  if (posted.status >= 300) throw new Error(`post failed (${posted.status}): ${JSON.stringify(posted.body)}`);

  const detail = await api.get(`/api/purchase-orders/${orderId}`);
  expect(detail.body.totalCents).toBe(200_000);
  return { orderId, api, billId: detail.body.bills[0].id as number };
}

async function paidOnBill(billId: number) {
  const rows = await prisma.payment.findMany({ where: { billId, status: { not: "VOID" } } });
  return rows.reduce((s, p) => s + p.amountCents, 0);
}

describe("partial payment on a vendor bill", () => {
  it("records the amount asked for, not the bill total", async () => {
    const { orderId, api, billId } = await postedOrder();
    const paid = await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 50_000 });
    expect(paid.status).toBe(201);
    expect(paid.body.payment.amountCents).toBe(50_000);
    expect(await paidOnBill(billId)).toBe(50_000);
  });

  it("stays payable until the balance reaches zero", async () => {
    const { orderId, api, billId } = await postedOrder();

    await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 80_000 });
    let order = await api.get(`/api/purchase-orders/${orderId}`);
    expect(order.body.status).toBe("POSTED");

    // The old guard closed the bill after ANY payment; a second instalment
    // must be accepted.
    const second = await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 120_000 });
    expect(second.status).toBe(201);
    order = await api.get(`/api/purchase-orders/${orderId}`);
    expect(order.body.status).toBe("PAID");
    expect(await paidOnBill(billId)).toBe(200_000);
  });

  it("posts a balanced ledger entry per instalment, at its own amount", async () => {
    const { orderId, api } = await postedOrder();
    const first = await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 75_000 });
    const second = await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 125_000 });

    for (const [res, amount] of [[first, 75_000], [second, 125_000]] as const) {
      const lines = await prisma.journalLine.findMany({ where: { journalEntryId: res.body.entry.id } });
      expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(amount);
      expect(lines.reduce((s, l) => s + l.creditCents, 0)).toBe(amount);
    }
  });

  it("defaults to the outstanding balance, not the total", async () => {
    const { orderId, api } = await postedOrder();
    await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 150_000 });
    const rest = await api.post(`/api/purchase-orders/${orderId}/pay`);
    expect(rest.body.payment.amountCents).toBe(50_000);
    expect((await api.get(`/api/purchase-orders/${orderId}`)).body.status).toBe("PAID");
  });

  it("refuses to overpay a vendor, in one go or by creep", async () => {
    const { orderId, api } = await postedOrder();
    expect((await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 200_001 })).status).toBe(400);
    await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 199_000 });
    expect((await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 2_000 })).status).toBe(400);
  });

  it("refuses a zero or negative amount", async () => {
    const { orderId, api } = await postedOrder();
    expect((await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 0 })).status).toBe(400);
    expect((await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: -1 })).status).toBe(400);
  });

  it("refuses a further payment once the bill is settled", async () => {
    const { orderId, api } = await postedOrder();
    await api.post(`/api/purchase-orders/${orderId}/pay`);
    const again = await api.post(`/api/purchase-orders/${orderId}/pay`).send({ amountCents: 1_000 });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
});
