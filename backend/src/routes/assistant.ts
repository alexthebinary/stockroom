import { Router } from "express";
import type { Express } from "express";
import { z } from "zod";
import { asyncHandler, parseBody } from "../http";
import { SESSION_HEADER } from "../auth";
import { assistantConfigured, chat } from "../assistant";

export const assistantRouter = Router();

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(60),
  route: z.string().max(200).default("/"),
  image: z.string().max(7_000_000).optional(),
});

/** GET /api/assistant/status — lets the UI hide the button when it is not configured. */
assistantRouter.get(
  "/assistant/status",
  asyncHandler(async (_req, res) => {
    res.json({ configured: assistantConfigured() });
  })
);

/**
 * POST /api/assistant/chat — one turn. Reads happen as the caller (their own
 * session is forwarded), so the assistant can see exactly what they can.
 */
assistantRouter.post(
  "/assistant/chat",
  asyncHandler(async (req, res) => {
    const body = parseBody(chatSchema, req.body);
    const result = await chat(
      req.app as Express,
      { session: req.header(SESSION_HEADER) ?? undefined, actAs: req.header("X-Act-As-Role") ?? undefined },
      { ...body, route: body.route ?? "/" }
    );
    res.json(result);
  })
);
