import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chat, type HelpResult } from "../ai/help";
import type { Deps } from "../app";
import { parse, sendError } from "../http";

/** Per-app, per-client rolling window, shared by ordinary and streaming turns. */
export function createHelpRateLimit(max = 60) {
  const clients = new Map<string, number[]>();
  const windowMs = 10 * 60_000;
  return (client: string, now = Date.now()): boolean => {
    for (const [key, times] of clients) if (now - times[times.length - 1]! >= windowMs) clients.delete(key);
    const recent = (clients.get(client) ?? []).filter((time) => now - time < windowMs);
    if (recent.length >= max) return true;
    recent.push(now);
    clients.set(client, recent);
    return false;
  };
}
const chatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(20)
    .refine((messages) => messages.at(-1)?.role === "user", "End with your question")
    .refine((messages) => messages.reduce((n, m) => n + m.content.length, 0) <= 16000, "Start a new conversation"),
  route: z.string().max(200).startsWith("/").default("/"),
});

export function registerHelp(app: FastifyInstance, { db, helpModel }: Deps) {
  const hit = createHelpRateLimit();
  app.get("/api/help/status", async () => ({ configured: Boolean(helpModel) }));
  for (const stream of [false, true]) {
    app.post(`/api/help/chat${stream ? "/stream" : ""}`, { bodyLimit: 40_000 }, async (request, reply) => {
      if (!helpModel) return sendError(reply, 503, "Help is not configured on this server.");
      const input = parse(chatBody, request.body);
      if (hit(request.ip)) {
        reply.header("Retry-After", "600");
        return sendError(reply, 429, "A lot of questions came from this device. Try again in a few minutes.");
      }
      const run = async (emit?: Parameters<typeof chat>[2]): Promise<HelpResult> => {
        const result = await chat(helpModel, input, emit);
        if (result.unanswered) {
          const feedback = await db.feedback.create({ data: {
            kind: "QUESTION", author: "help-assistant", note: input.messages.at(-1)!.content, path: input.route,
            context: { source: "help-assistant", reply: result.reply, conversation: input.messages },
          }, select: { id: true } });
          result.feedbackId = feedback.id;
          result.reply += "\nYour question was saved to improve the help pages.";
        }
        return result;
      };
      if (!stream) return run();
      // Sending a stream through Fastify retains the app's security headers and onSend hooks.
      const output = new PassThrough();
      reply.header("Content-Type", "application/x-ndjson; charset=utf-8").header("Cache-Control", "no-cache, no-transform").header("X-Accel-Buffering", "no");
      const line = (event: unknown) => { if (!output.destroyed) output.write(`${JSON.stringify(event)}\n`); };
      void run(line).then((result) => line({ type: "done", result })).catch((error) => {
        request.log.error(error);
        line({ type: "error", error: "Help could not finish or save your question. Please try again." });
      }).finally(() => output.end());
      return reply.send(output);
    });
  }
}
