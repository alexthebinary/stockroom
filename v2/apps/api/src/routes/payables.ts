import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { audit } from "../audit";
import { inTx } from "../db";
import { actorOf, idParam, parse } from "../http";
import { postVendorCredit } from "../purchasing/credits";
import { draftFreightBill, previewFreight } from "../purchasing/freight";
import { recordPayment, voidPayment } from "../purchasing/payments";
import { voidBill } from "../purchasing/void";

const paymentBody = z.object({
  amountCents: z.number().int().positive(),
  paidAt: z.coerce.date().default(() => new Date()),
  method: z.enum(["BANK", "CHECK", "CARD", "CASH", "ACH", "WIRE"]).default("BANK"),
  memo: z.string().max(500).nullish(),
});

export function registerPayables(app: FastifyInstance, { db }: Deps) {
  app.post("/api/freight-bills", async (request) => {
    const body = parse(
      z.object({
        kind: z.enum(["FREIGHT_IN", "FREIGHT_OUT"]),
        vendorId: z.number().int().positive(),
        vendorInvoiceNumber: z.string().trim().max(60).nullish(),
        billDate: z.coerce.date().default(() => new Date()),
        termsDays: z.number().int().min(0).max(365).optional(),
        amountCents: z.number().int().positive(),
        targetPoIds: z.array(z.number().int().positive()).default([]),
        allocationBasis: z.enum(["VALUE", "QTY"]).default("VALUE"),
        notes: z.string().max(2000).nullish(),
      }),
      request.body,
    );
    return inTx(db, (tx) => draftFreightBill(tx, body));
  });

  app.get("/api/bills/:id/freight-preview", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, (tx) => previewFreight(tx, id));
  });

  app.post("/api/bills/:id/credits", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(
      z.object({
        kind: z.enum(["RETURN", "PRICE_ALLOWANCE"]),
        date: z.coerce.date().default(() => new Date()),
        memo: z.string().max(500).nullish(),
        lines: z
          .array(
            z.object({
              billLineId: z.number().int().positive(),
              qty: z.number().int().min(0).default(0),
              amountCents: z.number().int().min(0).optional(),
              received: z.boolean().default(true),
              serials: z.array(z.string().trim().min(1)).optional(),
            }),
          )
          .min(1),
      }),
      request.body,
    );
    return inTx(db, async (tx) => {
      const credit = await postVendorCredit({ tx, actor: actorOf(request) }, id, body);
      await audit(tx, actorOf(request), "credit.posted", "VendorBill", id, { number: credit.number, totalCents: credit.totalCents });
      return credit;
    });
  });

  app.post("/api/bills/:id/payments", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(paymentBody, request.body);
    return inTx(db, (tx) => recordPayment({ tx, actor: actorOf(request) }, id, { direction: "OUT", ...body }));
  });

  app.post("/api/bills/:id/refunds", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(paymentBody, request.body);
    return inTx(db, (tx) => recordPayment({ tx, actor: actorOf(request) }, id, { direction: "IN", ...body }));
  });

  app.post("/api/payments/:id/void", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, (tx) => voidPayment({ tx, actor: actorOf(request) }, id));
  });

  app.get("/api/payments", async (request) => {
    const { billId, vendorId } = parse(z.object({ billId: z.coerce.number().int().optional(), vendorId: z.coerce.number().int().optional() }), request.query);
    return db.payment.findMany({ where: { ...(billId ? { billId } : {}), ...(vendorId ? { vendorId } : {}) }, orderBy: { id: "desc" }, take: 500 });
  });

  app.post("/api/bills/:id/void", async (request) => {
    const { id } = parse(idParam, request.params);
    return inTx(db, async (tx) => {
      const bill = await voidBill({ tx, actor: actorOf(request) }, id);
      await audit(tx, actorOf(request), "bill.voided", "VendorBill", id);
      return bill;
    });
  });
}
