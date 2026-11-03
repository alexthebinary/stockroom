import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { currentCompanyId } from "../companies";
import { parse } from "../http";

/** Test companies: list, start an empty one, throw one away. */
export function registerCompanies(app: FastifyInstance, { companies }: Deps) {
  app.get("/api/companies", async () => {
    const list = companies ? await companies.list() : [];
    return { enabled: Boolean(companies), current: currentCompanyId(), companies: list };
  });

  app.post("/api/companies", async (request, reply) => {
    if (!companies) throw new DomainError("Test companies are not available on this server", 404);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(120) }), request.body);
    return reply.status(201).send(await companies.create(name));
  });

  app.delete("/api/companies/:id", async (request) => {
    if (!companies) throw new DomainError("Test companies are not available on this server", 404);
    const { id } = parse(z.object({ id: z.string() }), request.params);
    await companies.remove(id);
    return { ok: true };
  });
}
