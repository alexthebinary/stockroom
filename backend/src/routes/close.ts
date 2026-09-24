import { Router } from "express";
import { actorOf, asyncHandler } from "../http";
import { requireMoney } from "../auth";
import { closeHistory, closePeriod, runCloseChecks } from "../close";

export const closeRouter = Router();

/** GET /api/close-history — every closed month, newest first. */
closeRouter.get(
  "/close-history",
  asyncHandler(async (_req, res) => {
    res.json({ records: await closeHistory() });
  })
);

/** GET /api/close/2026-09 — run the rulebook for a month. Reads are open. */
closeRouter.get(
  "/close/:period",
  asyncHandler(async (req, res) => {
    res.json(await runCloseChecks(String(req.params.period)));
  })
);

/** POST /api/close/2026-09 — re-prove, then lock. Money work, so gated. */
closeRouter.post(
  "/close/:period",
  requireMoney,
  asyncHandler(async (req, res) => {
    res.json(await closePeriod(String(req.params.period), actorOf(req)));
  })
);
