/** The clerk's receiving flow, end to end. */
import "./setup";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { as, boot, prisma } from "./helpers";

let app: Express; let token: string; let warehouseId: number; let poId: number; let lineId: number;

beforeAll(async () => {
  ({ app, token } = await boot());
  warehouseId = (await prisma.warehouse.create({ data: { name: "Dock", code: "DOCK" } })).id;
  const vendor = await prisma.vendor.create({ data: { name: "Unitree" } });
  const product = await prisma.product.create({
    data: { sku: "UT-G1-RCV", name: "Unitree G1", brand: "Unitree", trackingMode: "SERIAL" },
  });
  const created = await as(app, token).post("/api/purchase-orders").send({
    vendorId: vendor.id,
    lines: [{ productId: product.id, warehouseId, quantity: 3, unitCostCents: 1_000_000 }],
  });
  poId = created.body.id;
  await as(app, token).post(`/api/purchase-orders/${poId}/post`).send({});
  const full = await as(app, token).get(`/api/purchase-orders/${poId}`);
  lineId = full.body.lines[0].id;
});

const readers = (text: string) => [
  { id: "deepseek-vision", family: "deepseek", text, confidence: 0.94 },
  { id: "llama-vision", family: "llama", text, confidence: 0.91 },
];

describe("receiving", () => {
  it("lists what is expected at this dock", async () => {
    const res = await as(app, token).get(`/api/receiving/expected?warehouseId=${warehouseId}`);
    expect(res.status).toBe(200);
    const po = res.body.find((p: any) => p.id === poId);
    expect(po.outstanding).toBe(3);
    expect(po.lines[0].serialized).toBe(true);
  });

  it("scans a box and receives it with no human input", async () => {
    const res = await as(app, token).post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId, readers: readers("UT000001"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe("received");
    expect(res.body.serial).toBe("UT000001");
    expect(res.body.flagged, "two families agreed — nothing to review").toBe(false);
    expect(res.body.line.outstanding).toBe(2);

    const unit = await prisma.serialUnit.findFirstOrThrow({ where: { serialNumber: "UT000001" } });
    expect(unit.lotId, "a received unit is owned stock").not.toBeNull();
    expect(unit.warrantyStartAt).not.toBeNull();
  });

  it("commits a single-family read but floats it to the attention feed", async () => {
    const res = await as(app, token).post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId,
      readers: [{ id: "deepseek-vision", family: "deepseek", text: "UT000002", confidence: 0.6 }],
    });
    expect(res.body.outcome, "the dock keeps moving").toBe("received");
    expect(res.body.flagged).toBe(true);

    const feed = await as(app, token).get("/api/receiving/attention");
    expect(feed.body.some((f: any) => f.serialNumber === "UT000002")).toBe(true);
  });

  it("asks for another photo instead of a person when nothing is legible", async () => {
    const res = await as(app, token).post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId,
      readers: [{ id: "deepseek-vision", family: "deepseek", text: null }],
      attempt: 1,
    });
    expect(res.body.outcome).toBe("retry");
  });

  it("refuses to over-receive a completed line", async () => {
    await as(app, token).post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId, readers: readers("UT000003"),
    });
    const res = await as(app, token).post("/api/receiving/scan").send({
      purchaseOrderLineId: lineId, readers: readers("UT000004"),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/already received/i);
  });
});
