import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx } from "../db";
import { actorOf, parse } from "../http";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { clearSampleData, loadSampleData, SAMPLE } from "../sample";
import { landUnits } from "../stock";

const companyBody = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(400).optional(),
  homeState: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use the two-letter state code")
    .optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
});

const openingBody = z.object({
  date: z.coerce.date().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        qty: z.number().int().positive(),
        unitCostCents: z.number().int().min(0),
      }),
    )
    .min(1),
});

async function company(db: Deps["db"]) {
  return db.company.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/** Anything real yet? Sample data can only be cleared, and setup re-run, while not. */
async function hasActivity(db: Deps["db"]) {
  const [entries, orders, scans] = await Promise.all([db.journalEntry.count(), db.purchaseOrder.count(), db.scanSession.count()]);
  return entries + orders + scans > 0;
}

export function registerSetup(app: FastifyInstance, { db }: Deps) {
  app.get("/api/setup", async () => {
    const row = await company(db);
    const [profiles, warehouses, vendors, items, stocked] = await Promise.all([
      db.profile.count({ where: { isActive: true } }),
      db.warehouse.count({ where: { isActive: true } }),
      db.vendor.count({ where: { isActive: true } }),
      db.item.count({ where: { isActive: true } }),
      db.stockBalance.count({ where: { onHand: { gt: 0 } } }),
    ]);
    return {
      company: row,
      required: row.setupCompletedAt == null,
      counts: { profiles, warehouses, vendors, items, stocked },
      sample: { loaded: row.sampleDataLoadedAt != null, canClear: row.sampleDataLoadedAt != null && !(await hasActivity(db)), ...SAMPLE },
    };
  });

  app.put("/api/setup/company", async (request) => {
    const body = parse(companyBody, request.body);
    await company(db);
    return db.company.update({ where: { id: 1 }, data: body });
  });

  /** Resumable wizard: remember the furthest step reached. */
  app.put("/api/setup/step", async (request) => {
    const { step } = parse(z.object({ step: z.number().int().min(0).max(20) }), request.body);
    await company(db);
    return db.company.update({ where: { id: 1 }, data: { setupStep: step } });
  });

  app.post("/api/setup/sample-data", async (request) => {
    const row = await company(db);
    if (row.sampleDataLoadedAt) throw new DomainError("Sample data is already loaded", 409);
    if ((await db.item.count()) > 0 || (await db.warehouse.count()) > 0) {
      throw new DomainError("Sample data is for an empty company; this one already has warehouses or items", 409);
    }
    return inTx(db, async (tx) => {
      await loadSampleData(tx);
      await audit(tx, actorOf(request), "sample.loaded", "Company", 1);
      return tx.company.update({ where: { id: 1 }, data: { sampleDataLoadedAt: new Date() } });
    });
  });

  app.delete("/api/setup/sample-data", async (request) => {
    if (await hasActivity(db)) throw new DomainError("Sample data can't be cleared once orders, scans or entries exist", 409);
    return inTx(db, async (tx) => {
      await clearSampleData(tx);
      await audit(tx, actorOf(request), "sample.cleared", "Company", 1);
      return tx.company.update({ where: { id: 1 }, data: { sampleDataLoadedAt: null } });
    });
  });

  /**
   * Opening stock (GAAP guide §II.3 #1): what was on the shelves before the
   * books started. Dr Inventory / Cr Opening Balance Equity, item by item.
   */
  app.post("/api/setup/opening-stock", async (request) => {
    const body = parse(openingBody, request.body);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const docNumber = await nextNumber(tx, "ADJ");
      const date = body.date ?? new Date();
      const entryLines = [];
      let total = 0;
      for (const line of body.lines) {
        const valueCents = line.qty * line.unitCostCents;
        await landUnits({ tx, actor }, { ...line, valueCents, fromHeld: false, docNumber, counter: { type: "OPENING", id: 0 }, register: "ADJ" });
        await tx.item.update({ where: { id: line.itemId }, data: { lastCostCents: line.unitCostCents } });
        entryLines.push({ role: "inventoryOnHand" as const, amountCents: valueCents, itemId: line.itemId });
        total += valueCents;
      }
      const entry = await postEntry(tx, {
        event: "OPENING_STOCK",
        date,
        sourceType: "OPENING",
        sourceId: 0,
        actor,
        memo: `Opening stock ${docNumber}`,
        lines: [...entryLines, { role: "openingEquity", amountCents: total }],
      });
      await audit(tx, actor, "opening.posted", "Company", 1, { docNumber, total });
      return { docNumber, totalCents: total, entry };
    });
  });

  app.post("/api/setup/complete", async (request) => {
    const row = await company(db);
    const missing = [];
    if (!row.name) missing.push("the company name");
    if ((await db.profile.count({ where: { isActive: true } })) === 0) missing.push("at least one team profile");
    if ((await db.warehouse.count({ where: { isActive: true } })) === 0) missing.push("a warehouse");
    if (missing.length) throw new DomainError(`Before finishing, add ${missing.join(", ")}`, 400);
    return inTx(db, async (tx) => {
      await audit(tx, actorOf(request), "setup.completed", "Company", 1);
      return tx.company.update({ where: { id: 1 }, data: { setupCompletedAt: new Date() } });
    });
  });
}
