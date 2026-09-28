/**
 * The product record carries three per-unit cost lines (2026-09-28, operator):
 * cost of goods, supplier shipping, and their total. Tested over HTTP because
 * zod strips unknown keys silently — the 2026-09-20 trackingMode bug passed a
 * suite that set fields through Prisma.
 *
 * ⚠️ "./setup" first — DATABASE_URL before src/db.ts builds PrismaClient.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot } from "./helpers";

let app: Express;
let token: string;

beforeAll(async () => {
  ({ app, token } = await boot());
});

describe("product unit-cost lines", () => {
  it("stores cost of goods and supplier shipping, and derives the total", async () => {
    const api = as(app, token);
    const created = await api.post("/api/products").send({
      sku: "UC-1", name: "Unit cost", costOfGoodsCents: 10_000, supplierShippingCents: 1_250,
    });
    expect(created.status).toBe(201);
    const got = await api.get(`/api/products/${created.body.id}`);
    expect(got.body).toMatchObject({
      costOfGoodsCents: 10_000, supplierShippingCents: 1_250, totalUnitCostCents: 11_250,
    });
    expect(got.body).not.toHaveProperty("defaultCostCents");
  });

  it("carries the total on the list too", async () => {
    const api = as(app, token);
    const list = await api.get("/api/products?search=UC-1");
    expect(list.body.data[0]).toMatchObject({ sku: "UC-1", totalUnitCostCents: 11_250 });
  });

  it("defaults both lines to zero", async () => {
    const api = as(app, token);
    const created = await api.post("/api/products").send({ sku: "UC-2", name: "Zero" });
    const got = await api.get(`/api/products/${created.body.id}`);
    expect(got.body).toMatchObject({ costOfGoodsCents: 0, supplierShippingCents: 0, totalUnitCostCents: 0 });
  });

  it("refuses a negative shipping cost", async () => {
    const res = await as(app, token)
      .post("/api/products")
      .send({ sku: "UC-3", name: "Neg", supplierShippingCents: -1 });
    expect(res.status).toBe(400);
  });
});
