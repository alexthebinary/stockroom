/**
 * trackingMode must be settable OVER HTTP, not just in the database.
 *
 * 🔴 WHY THIS FILE EXISTS. Until 2026-09-20 `trackingMode` was read in six
 * places and writable in none: it was missing from the product route's zod
 * schema, and zod strips unknown keys SILENTLY. A create carrying
 * trackingMode:"SERIAL" returned 201 with the field discarded.
 *
 * The whole serial suite passed throughout, because every one of those tests
 * set trackingMode directly through Prisma in its own setup and never crossed
 * the API boundary. A production test run found it in the first minute.
 *
 * The lesson encoded here: if a feature is reached over HTTP in real use, at
 * least one test must reach it over HTTP too. Setup convenience is exactly
 * where this class of gap hides.
 */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express;
let token: string;

beforeAll(async () => { ({ app, token } = await boot()); });

describe("trackingMode over the API", () => {
  it("persists SERIAL from a create request", async () => {
    const res = await as(app, token).post("/api/products").send({
      sku: "HTTP-SERIAL-1", name: "Serialized via HTTP", brand: "Unitree",
      trackingMode: "SERIAL",
    });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.trackingMode, "the field must survive the round trip").toBe("SERIAL");

    const row = await prisma.product.findUniqueOrThrow({ where: { sku: "HTTP-SERIAL-1" } });
    expect(row.trackingMode).toBe("SERIAL");
  });

  it("defaults to NONE when unspecified", async () => {
    const res = await as(app, token).post("/api/products").send({
      sku: "HTTP-PLAIN-1", name: "Ordinary",
    });
    expect(res.body.trackingMode).toBe("NONE");
  });

  it("rejects a value outside the enum rather than silently dropping it", async () => {
    // Silent acceptance is what caused the original bug.
    const res = await as(app, token).post("/api/products").send({
      sku: "HTTP-BAD-1", name: "Bad mode", trackingMode: "LOT",
    });
    expect(res.status).toBe(400);
  });

  it("a serialized product is reported as serialized by the receiving API", async () => {
    // The end-to-end consequence: the dock must SEE that a line needs serials.
    const p = await as(app, token).post("/api/products").send({
      sku: "HTTP-SERIAL-2", name: "Dock visible", brand: "Unitree", trackingMode: "SERIAL",
    });
    const wh = await prisma.warehouse.create({ data: { name: "HTTP WH", code: "HWH" } });
    const vendor = await prisma.vendor.create({ data: { name: "HTTP Vendor" } });
    const po = await as(app, token).post("/api/purchase-orders").send({
      vendorId: vendor.id,
      lines: [{ productId: p.body.id, warehouseId: wh.id, quantity: 1, unitCostCents: 1000 }],
    });
    await as(app, token).post(`/api/purchase-orders/${po.body.id}/post`).send({});

    const exp = await as(app, token).get(`/api/receiving/expected?warehouseId=${wh.id}`);
    const line = exp.body.flatMap((o: any) => o.lines).find((l: any) => l.sku === "HTTP-SERIAL-2");
    expect(line?.serialized, "the dock must know this line needs serials").toBe(true);
  });
});
