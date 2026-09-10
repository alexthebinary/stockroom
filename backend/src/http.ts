import { Prisma } from "@prisma/client";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodSchema } from "zod";
import { ApiError, badRequest } from "./errors";

/** Wraps an async route so rejected promises reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest("Validation failed", result.error.flatten());
  }
  return result.data;
}

/** The demo has no real auth; the actor is whatever the client claims to be. */
export function actorOf(req: Request): string {
  const header = req.header("X-Demo-User");
  return header && header.trim() ? header.trim() : "demo@user.com";
}

export function intParam(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  return n;
}

export function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** Standard pagination: ?page=1&pageSize=25 */
export function pagination(query: Record<string, unknown>) {
  const page = Math.max(1, optionalInt(query.page) ?? 1);
  const pageSize = Math.min(200, Math.max(1, optionalInt(query.pageSize) ?? 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Turns ?sort=&dir= into a Prisma orderBy, but only for columns the caller is
 * allowed to sort on. `availableQty` is derived and has no column, so it is
 * deliberately not sortable — sorting it would need the whole table in memory
 * and would break pagination.
 */
export function orderByFrom<T>(
  query: Record<string, unknown>,
  allowed: Record<string, T>,
  fallback: T
): T {
  const sort = String(query.sort ?? "");
  const dir = String(query.dir ?? "asc") === "desc" ? "desc" : "asc";
  const column = allowed[sort];
  if (!column) return fallback;
  // Each entry is a template with a placeholder direction; fill it in.
  return JSON.parse(JSON.stringify(column).replaceAll('"__dir__"', `"${dir}"`)) as T;
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }
  // Map Prisma's known error codes explicitly. Matching on the message text
  // is fragile and lets everything else surface as a raw 500.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        res.status(409).json({ error: "A record with that unique value already exists" });
        return;
      case "P2003":
        res.status(409).json({
          error: "That record is still referenced by other data and cannot be changed",
        });
        return;
      case "P2025":
        res.status(404).json({ error: "Record not found" });
        return;
      default:
        res.status(400).json({ error: `Database rejected the request (${err.code})` });
        return;
    }
  }

  const message = err instanceof Error ? err.message : "Unexpected error";
  // SQLite serialises writers; under contention it reports a locked database
  // rather than corrupting anything. Retrying is the correct client response.
  if (message.includes("database is locked") || message.includes("SQLITE_BUSY")) {
    res.status(409).json({ error: "The database was busy, please retry" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: message });
}
