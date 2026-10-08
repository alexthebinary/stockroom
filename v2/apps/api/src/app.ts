import { DomainError } from "@pi/domain";
import Fastify, { type FastifyInstance } from "fastify";
import type { Reader } from "./ai/reader";
import type { Db } from "./db";
import type { Profile } from "./generated/prisma/client";
import { sendError } from "./http";
import { registerAccounting } from "./routes/accounting";
import { registerCatalog } from "./routes/catalog";
import { registerSetup } from "./routes/setup";

declare module "fastify" {
  interface FastifyRequest {
    profile: Profile | null;
  }
}

export type Deps = { db: Db; reader: Reader | null };

const OPEN_WITHOUT_PROFILE = ["/api/setup", "/api/profiles", "/api/health"];

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false, bodyLimit: 15 * 1024 * 1024 });

  app.decorateRequest("profile", null);

  /**
   * "Who's working" — no sign-in (operator decision). The device sends the
   * chosen profile on every request; it is stamped on whatever they do. Once
   * the team exists, a change without a profile is refused so nothing is
   * booked to nobody.
   */
  app.addHook("preHandler", async (request) => {
    const raw = request.headers["x-profile"];
    if (raw) {
      const id = Number(raw);
      const profile = Number.isInteger(id) ? await deps.db.profile.findUnique({ where: { id } }) : null;
      if (!profile || !profile.isActive) throw new DomainError("That profile is no longer active. Pick who's working again.", 401);
      request.profile = profile;
      return;
    }
    const isChange = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const open = OPEN_WITHOUT_PROFILE.some((prefix) => request.url.startsWith(prefix));
    if (isChange && !open && (await deps.db.profile.count({ where: { isActive: true } })) > 0) {
      throw new DomainError("Pick who's working first", 401);
    }
  });

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number; meta?: unknown }, request, reply) => {
    if (error instanceof DomainError) return sendError(reply, error.status, error.message);
    const message = String(error.message ?? "");
    // Prisma's known errors, and Postgres errors surfaced through the driver adapter.
    if (error.code === "P2002" || /unique constraint/i.test(message)) return sendError(reply, 409, "That already exists");
    if (error.code === "P2025") return sendError(reply, 404, "That record was not found");
    if (error.code === "P2034" || /could not serialize|deadlock detected/i.test(message)) {
      return sendError(reply, 409, "Someone else changed this at the same moment. Try again.");
    }
    if (/violates check constraint|does not balance/i.test(message)) {
      return sendError(reply, 409, "That would break a stock or money rule (it may have changed while you were working). Refresh and try again.");
    }
    if (error.statusCode && error.statusCode < 500) return sendError(reply, error.statusCode, message);
    request.log.error(error);
    return sendError(reply, 500, "Something went wrong on our side. Nothing was saved.");
  });

  app.get("/api/health", async () => ({ ok: true }));

  registerSetup(app, deps);
  registerCatalog(app, deps);
  registerAccounting(app, deps);
  return app;
}
