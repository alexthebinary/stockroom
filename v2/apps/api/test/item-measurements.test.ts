import { describe, expect, it } from "vitest";
import { ok, sampleCompany } from "./helpers";

describe("item weight and dimensions", () => {
  it("round-trips measurements through create, update, list and get; omission preserves them and null clears them", async () => {
    const { admin, accountant } = await sampleCompany();
    const measurements = { weightKg: 1.2, lengthCm: 30, widthCm: 20, heightCm: 10 };
    const item = ok(await admin.post("/api/items", { sku: "MEASURED", name: "Measured item", ...measurements })).body;
    expect(item).toMatchObject(measurements);
    expect(ok(await accountant.get(`/api/items/${item.id}`)).body).toMatchObject(measurements);
    expect(ok(await accountant.get("/api/items?search=MEASURED")).body).toEqual([expect.objectContaining({ id: item.id, ...measurements })]);

    const changed = { weightKg: 2.5, lengthCm: 40.5, widthCm: 25.5, heightCm: 15.5 };
    expect(ok(await admin.put(`/api/items/${item.id}`, changed)).body).toMatchObject(changed);
    ok(await admin.put(`/api/items/${item.id}`, { name: "Renamed item" }));
    expect(ok(await accountant.get(`/api/items/${item.id}`)).body).toMatchObject({ name: "Renamed item", ...changed });

    const cleared = { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
    expect(ok(await admin.put(`/api/items/${item.id}`, cleared)).body).toMatchObject(cleared);
    expect(ok(await accountant.get(`/api/items/${item.id}`)).body).toMatchObject(cleared);
    expect(ok(await accountant.get("/api/items?search=MEASURED")).body).toEqual([expect.objectContaining(cleared)]);
    expect(ok(await admin.post("/api/items", { sku: "UNMEASURED", name: "No measurements", ...cleared })).body).toMatchObject(cleared);
  });

  it("rejects zero and negative measurements on both create and update", async () => {
    const { admin, ids } = await sampleCompany();
    for (const field of ["weightKg", "lengthCm", "widthCm", "heightCm"]) {
      for (const value of [0, -1]) {
        expect((await admin.post("/api/items", { sku: "INVALID", name: "Invalid item", [field]: value })).status, `${field}=${value} on create`).toBe(400);
        expect((await admin.put(`/api/items/${ids.widget}`, { [field]: value })).status, `${field}=${value} on update`).toBe(400);
      }
    }
  });

  it("previews and imports optional measurement columns, allowing blank values and legacy CSVs", async () => {
    const { admin, accountant } = await sampleCompany();
    const csv = "sku,name,weight_kg,length_cm,width_cm,height_cm\nCSV-MEASURED,Measured import,1.2,30,20,10\nCSV-BLANK,Blank measurements,,,,";
    const measurements = { weightKg: 1.2, lengthCm: 30, widthCm: 20, heightCm: 10 };
    const preview = ok(await admin.post("/api/import/items", { csv })).body;
    expect(preview).toMatchObject({ commit: false, results: [{ row: 2, ok: true, data: measurements }, { row: 3, ok: true }] });
    expect(ok(await accountant.get("/api/items?search=CSV-")).body).toEqual([]);
    expect(ok(await admin.post("/api/import/items", { csv, commit: true })).body.commit).toBe(true);
    const imported = ok(await accountant.get("/api/items?search=CSV-")).body;
    expect(imported).toEqual([
      expect.objectContaining({ sku: "CSV-BLANK", weightKg: null, lengthCm: null, widthCm: null, heightCm: null }),
      expect.objectContaining({ sku: "CSV-MEASURED", ...measurements }),
    ]);
    expect(ok(await accountant.get(`/api/items/${imported[1].id}`)).body).toMatchObject(measurements);
    expect(ok(await admin.post("/api/import/items", { csv: "sku,name\nCSV-LEGACY,Legacy import", commit: true })).body.commit).toBe(true);
    expect(ok(await accountant.get("/api/items?search=CSV-LEGACY")).body).toEqual([expect.objectContaining({ weightKg: null, lengthCm: null, widthCm: null, heightCm: null })]);
  });

  it("rejects invalid CSV measurements before committing any rows", async () => {
    const { admin, accountant } = await sampleCompany();
    for (const field of ["weight_kg", "length_cm", "width_cm", "height_cm"]) {
      for (const value of ["0", "-1", "not-a-number"]) {
        const csv = `sku,name,${field}\nCSV-VALID,Valid item,1\nCSV-INVALID,Invalid item,${value}`;
        const response = ok(await admin.post("/api/import/items", { csv, commit: true })).body;
        expect(response).toMatchObject({ commit: false, results: [{ row: 2, ok: true }, { row: 3, ok: false }] });
      }
    }
    expect(ok(await accountant.get("/api/items?search=CSV-")).body).toEqual([]);
  });
});
