import { Router } from "express";
import type { Express } from "express";
import { z } from "zod";
import { asyncHandler, parseBody } from "../http";
import { ApiError } from "../errors";
import { SESSION_HEADER } from "../auth";
import { assistantConfigured, chat } from "../assistant";

export const assistantRouter = Router();

/**
 * A cap on assistant turns per client, because every turn spends prepaid model
 * credit and the beta runs with no site password. Generous for a person (a
 * turn takes 5–15 s), useless for a script. In memory: resets on deploy, and
 * that is fine for a guard whose job is to bound the damage, not to bill.
 */
const WINDOW_MS = 10 * 60_000;
const MAX_TURNS = Number(process.env.ASSISTANT_MAX_TURNS_PER_10MIN ?? 60);
const turns = new Map<string, number[]>();

export function assistantRateLimitHit(client: string, now = Date.now()) {
  const recent = (turns.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_TURNS) {
    turns.set(client, recent);
    return true;
  }
  recent.push(now);
  turns.set(client, recent);
  return false;
}

const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(60),
  route: z.string().max(200).default("/"),
  image: z.string().max(7_000_000).optional(),
  full: z.boolean().optional(),
  fastOk: z.boolean().optional(),
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
    if (assistantRateLimitHit(req.ip ?? "unknown")) {
      throw new ApiError(429, "The assistant has had a lot of questions from here in the last few minutes — try again shortly");
    }
    const body = parseBody(chatSchema, req.body);
    const result = await chat(
      req.app as Express,
      { session: req.header(SESSION_HEADER) ?? undefined, actAs: req.header("X-Act-As-Role") ?? undefined },
      { ...body, route: body.route ?? "/" }
    );
    res.json(result);
  })
);

/**
 * POST /api/assistant/chat/stream — the same turn, streamed as NDJSON: status
 * lines while it reads, the reply's text as it is written, then one `done`
 * line carrying exactly what /assistant/chat would have returned. Errors
 * before the stream opens are ordinary JSON responses; after, an `error` line.
 */
assistantRouter.post(
  "/assistant/chat/stream",
  asyncHandler(async (req, res) => {
    if (assistantRateLimitHit(req.ip ?? "unknown")) {
      throw new ApiError(429, "The assistant has had a lot of questions from here in the last few minutes — try again shortly");
    }
    const body = parseBody(chatSchema, req.body);
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const line = (o: unknown) => res.write(JSON.stringify(o) + "\n");
    try {
      const result = await chat(
        req.app as Express,
        { session: req.header(SESSION_HEADER) ?? undefined, actAs: req.header("X-Act-As-Role") ?? undefined },
        { ...body, route: body.route ?? "/" },
        line
      );
      line({ type: "done", result });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      // ApiError messages are written for people; anything else stays in the log.
      if (!err.status) console.error("[assistant stream]", e);
      line({ type: "error", status: err.status ?? 500, error: err.status ? err.message : "The assistant failed. Try again." });
    }
    res.end();
  })
);
