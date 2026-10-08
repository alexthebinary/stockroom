import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx } from "../db";
import { actorOf, parse } from "../http";
import { postEntry } from "../ledger";
import { nextNumber } from "../numbering";
import { issueUnits, landUnits } from "../stock";

/**
 * Found or lost stock (GAAP guide §II.3 #2, #3): a count was off, a box
 * arrived damaged. A loss leaves at average cost (Dr Inventory Adjustment Loss
 * / Cr Inventory); a gain comes in at the average, or at a cost given
 * (Dr Inventory / Cr Inventory Adjustment Gain). Always one named item.
 */
export function registerAdjustments(app: FastifyInstance, { db }: Deps) {
  app.post("/api/adjustments", async (request) => {
    const body = parse(
      z.object({
        itemId: z.number().int().positive(),
        warehouseId: z.number().int().positive(),
        qty: z.number().int().refine((n) => n !== 0, "enter how many units were found (+) or lost (−)"),
        unitCostCents: z.number().int().min(0).optional(),
        reason: z.string().trim().min(3, "say why — it goes on the record").max(300),
      }),
      request.body,
    );
    const actor = actorOf(request);
    return inTx(db, async (tx) => {
      const item = await tx.item.findUniqueOrThrow({ where: { id: body.itemId } });
      if (item.trackingMode === "SERIAL") throw new DomainError(`${item.name} is serial-tracked; adjust it unit by unit from its serial record`, 400);
      const docNumber = await nextNumber(tx, "ADJ");
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
      return { docNumber, qty: body.qty, valueCents };
    });
  });
}
