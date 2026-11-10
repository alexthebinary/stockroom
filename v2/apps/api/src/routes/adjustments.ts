import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx, type Tx } from "../db";
import { actorOf, parse } from "../http";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits, landUnits } from "../stock";

const adjustmentBody = z.object({
  itemId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  qty: z.number().int().refine((n) => n !== 0, "enter how many units were found (+) or lost (−)"),
  unitCostCents: z.number().int().min(0).optional(),
  reason: z.string().trim().min(3, "say why — it goes on the record").max(300),
});

type AdjustmentBody = z.infer<typeof adjustmentBody>;

/**
 * One found-or-lost line on an ADJ document that the caller has already numbered.
 * A loss leaves at average cost; a gain comes in at the given cost, else the
 * average, else the item's last cost. Same rules as a one-line adjustment.
 */
async function applyAdjustment(tx: Tx, actor: string, docNumber: string, body: AdjustmentBody) {
  const item = await tx.item.findUniqueOrThrow({ where: { id: body.itemId } });
  if (item.trackingMode === "SERIAL") throw new DomainError(`${item.name} is serial-tracked; adjust it unit by unit from its serial record`, 400);
  const counter = { type: "ADJUSTMENT" as const, id: 0 };
  let valueCents: number;
  if (body.qty < 0) {
    valueCents = await issueUnits({ tx, actor }, { itemId: item.id, warehouseId: body.warehouseId, qty: -body.qty, docNumber, counter, register: "ADJ" });
    await postEntry(tx, {
      event: "INVENTORY_ADJUSTMENT_LOSS",
      date: new Date(),
      sourceType: "ADJUSTMENT",
      sourceId: 0,
      actor,
      memo: `${docNumber}: ${body.reason}`,
      lines: [
        { role: "adjustmentLoss", amountCents: valueCents, itemId: item.id },
        { role: "inventoryOnHand", amountCents: valueCents, itemId: item.id },
      ],
    });
  } else {
    const pool = await tx.costPool.findUnique({ where: { itemId: item.id } });
    const unit = body.unitCostCents ?? (pool && pool.qty > 0 ? Math.round(pool.valueCents / pool.qty) : item.lastCostCents);
    valueCents = unit * body.qty;
    await landUnits({ tx, actor }, { itemId: item.id, warehouseId: body.warehouseId, qty: body.qty, valueCents, fromHeld: false, docNumber, counter, register: "ADJ" });
    await postEntry(tx, {
      event: "INVENTORY_ADJUSTMENT_GAIN",
      date: new Date(),
      sourceType: "ADJUSTMENT",
      sourceId: 0,
      actor,
      memo: `${docNumber}: ${body.reason}`,
      lines: [
        { role: "inventoryOnHand", amountCents: valueCents, itemId: item.id },
        { role: "adjustmentGain", amountCents: valueCents },
      ],
    });
  }
  await audit(tx, actor, "stock.adjusted", "Item", item.id, { docNumber, qty: body.qty, valueCents, reason: body.reason });
  return { itemId: item.id, warehouseId: body.warehouseId, qty: body.qty, valueCents };
}

/**
 * Found or lost stock (GAAP guide §II.3 #2, #3): a count was off, a box
 * arrived damaged. Always one named item per line. A stock count posts every
 * difference on one shared ADJ number, or posts none of them.
 */
export function registerAdjustments(app: FastifyInstance, { db }: Deps) {
  app.post("/api/adjustments", async (request) => {
    const body = parse(adjustmentBody, request.body);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const docNumber = await nextNumber(tx, "ADJ");
      const line = await applyAdjustment(tx, actor, docNumber, body);
      return { docNumber, qty: line.qty, valueCents: line.valueCents };
    });
  });

  app.post("/api/adjustments/batch", async (request) => {
    const lines = parse(z.array(adjustmentBody).min(1, "a stock count needs at least one difference"), request.body);
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const docNumber = await nextNumber(tx, "ADJ");
      const posted = [];
      for (const line of lines) posted.push(await applyAdjustment(tx, actor, docNumber, line));
      return { docNumber, lines: posted };
    });
  });
}
