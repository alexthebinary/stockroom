import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { idParam, notFound, parse } from "../http";
import { requireAutoToken } from "./feedback";

const STATUSES = ["OPEN", "ANSWERED", "WITHDRAWN"] as const;
const listQuery = z.object({ status: z.enum(STATUSES).optional() });
const createBody = z.object({
  text: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(1000).nullish(),
  feedbackIds: z.array(z.number().int().positive()).max(50).optional(),
});
const answerBody = z.object({
  answer: z.string().trim().min(1).max(4000),
  author: z.string().trim().nullish(),
});
const patchBody = z.object({ status: z.enum(["WITHDRAWN", "OPEN"]) });

/** Follow-up questions the build team posts for Serhii, and his answers. */
export function registerQuestions(app: FastifyInstance, { db }: Deps) {
  app.get("/api/questions", async (request) => {
    const { status } = parse(listQuery, request.query);
    return db.teamQuestion.findMany({ where: status ? { status } : undefined, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  });

  app.post("/api/questions", async (request, reply) => {
    requireAutoToken(request);
    const body = parse(createBody, request.body);
    const row = await db.teamQuestion.create({
      data: {
        text: body.text,
        context: body.context || null,
        feedbackIds: [...new Set(body.feedbackIds ?? [])],
      },
    });
    return reply.status(201).send(row);
  });

  app.post("/api/questions/:id/answer", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(answerBody, request.body);
    if (!(await db.teamQuestion.findUnique({ where: { id }, select: { id: true } }))) throw notFound("That question");
    return db.teamQuestion.update({
      where: { id },
      data: {
        status: "ANSWERED",
        answer: body.answer,
        answeredBy: request.profile?.name ?? (body.author || "Tester"),
        answeredAt: new Date(),
      },
    });
  });

  app.patch("/api/questions/:id", async (request) => {
    requireAutoToken(request);
    const { id } = parse(idParam, request.params);
    const { status } = parse(patchBody, request.body);
    if (!(await db.teamQuestion.findUnique({ where: { id }, select: { id: true } }))) throw notFound("That question");
    return db.teamQuestion.update({ where: { id }, data: { status } });
  });
}
