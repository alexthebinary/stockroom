import { DomainError } from "@pi/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new DomainError(`Check the form: ${detail}`, 400);
  }
  return result.data;
}

export const notFound = (what: string) => new DomainError(`${what} was not found`, 404);

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Who did it, for every journal entry, movement and audit row. */
export function actorOf(request: FastifyRequest): string {
  return request.profile ? request.profile.name : "setup";
}

export function sendError(reply: FastifyReply, status: number, message: string, details?: unknown) {
  return reply.status(status).send({ error: message, ...(details ? { details } : {}) });
}

export const money = z.number().int();
export const positiveQty = z.number().int().positive();
export const isoDate = z.coerce.date();
