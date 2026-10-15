import { DomainError } from "@pi/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ClarifyNote, Spec, Turn } from "../ai/clarifier";
import type { Deps } from "../app";
import { idParam, notFound, parse } from "../http";
import { notify } from "../notify";

export const UNAVAILABLE = "I'll ask you later — your note is saved.";

const feedbackBody = z.object({
  kind: z.enum(["BUG", "IDEA", "QUESTION"]),
  note: z.string().trim().min(1),
  path: z.string(),
  pageTitle: z.string().nullish(),
  anchor: z.record(z.string(), z.unknown()).nullish(),
  context: z.record(z.string(), z.unknown()).default({}),
  author: z.string().trim().nullish(),
  /** A data URL from the device: data:image/jpeg;base64,… */
  screenshot: z.string().nullish(),
});

const listQuery = z.object({ path: z.string().optional(), status: z.enum(["OPEN", "DONE", "WONTFIX"]).optional() });
const LIST_FIELDS = { id: true, kind: true, status: true, note: true, path: true, pageTitle: true, anchor: true, context: true, author: true, authorJob: true, screenshotType: true, createdAt: true, updatedAt: true, spec: true, specState: true, autoState: true, autoNote: true, autoCommit: true, revision: true, autoRevision: true, autoClaim: true, _count: { select: { turns: true } } } as const;
const shape = <T extends { screenshotType: string | null; _count: { turns: number } }>({ _count, ...row }: T) => ({ ...row, hasScreenshot: row.screenshotType != null, turnCount: _count.turns });

/** Beta feedback: notes pinned to a spot in the app, with what the device knew. */
export function registerFeedback(app: FastifyInstance, { db, clarifier }: Deps) {
  app.post("/api/feedback", async (request, reply) => {
    const body = parse(feedbackBody, request.body);
    const shot = body.screenshot?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    const row = await db.feedback.create({
      data: {
        kind: body.kind,
        note: body.note,
        path: body.path,
        pageTitle: body.pageTitle ?? null,
        anchor: (body.anchor ?? undefined) as never,
        context: body.context as never,
        author: request.profile?.name ?? (body.author || "Tester"),
        authorJob: request.profile?.job ?? null,
        screenshot: shot?.[2] ? new Uint8Array(Buffer.from(shot[2], "base64")) : null,
        screenshotType: shot?.[2] ? (shot[1] ?? null) : null,
      },
      select: { id: true, author: true },
    });
    const origin = `${request.protocol}://${request.headers.host}`;
    notify(`New ${body.kind.toLowerCase()} from ${row.author}`, `${body.note.slice(0, 240)}\n${body.path}`, { click: `${origin}/feedback`, tags: [body.kind === "BUG" ? "beetle" : body.kind === "IDEA" ? "bulb" : "question"] });
    return reply.status(201).send({ id: row.id });
  });

  app.get("/api/feedback", async (request) => {
    const query = parse(listQuery, request.query);
    const rows = await db.feedback.findMany({ where: query, orderBy: { id: "desc" }, select: LIST_FIELDS });
    return rows.map(shape);
  });

  const turnsOf = async (feedbackId: number): Promise<Turn[]> =>
    (await db.feedbackTurn.findMany({ where: { feedbackId }, orderBy: { id: "asc" }, select: { role: true, content: true } })) as Turn[];
  const state = async (id: number, text: string | null, extra: { unavailable?: true } = {}) => {
    const row = await db.feedback.findUniqueOrThrow({ where: { id }, select: { spec: true, specState: true, revision: true } });
    return { text, ...extra, spec: (row.spec as Spec | null) ?? null, specState: row.specState, revision: row.revision, turns: await turnsOf(id) };
  };

  app.post("/api/feedback/:id/clarify", async (request) => {
    const { id } = parse(idParam, request.params);
    const { message } = parse(z.object({ message: z.string().trim().min(1).max(2000).optional() }), request.body ?? {});
    const row = await db.feedback.findUnique({ where: { id } });
    if (!row) throw notFound("That note");
    const existing = await db.feedbackTurn.count({ where: { feedbackId: id } });
    if (!message && existing > 0) return state(id, null);   // reopening the chat: never re-ask
    if (message) {
      await db.$transaction([
        db.feedbackTurn.create({ data: { feedbackId: id, role: "user", content: message } }),
        db.feedback.update({ where: { id }, data: { revision: { increment: 1 }, ...(row.specState === "CONFIRMED" ? { specState: "PROPOSED" } : {}) } }),
      ]);
    }
    if (!clarifier) return state(id, UNAVAILABLE, { unavailable: true });
    const anchor = (row.anchor ?? {}) as { label?: string };
    const ctx = row.context as { errors?: { message?: string }[] };
    const input: ClarifyNote = { kind: row.kind, note: row.note, path: row.path, pageTitle: row.pageTitle, anchorLabel: anchor.label ?? "", errors: (ctx.errors ?? []).map((e) => String(e.message ?? "")).slice(-5) };
    const result = await clarifier.clarify({ note: input, turns: (await turnsOf(id)).slice(-10) });
    if (!result.ok) return state(id, UNAVAILABLE, { unavailable: true });
    await db.$transaction([
      db.feedbackTurn.create({ data: { feedbackId: id, role: "assistant", content: result.text } }),
      ...(result.spec ? [db.feedback.update({ where: { id }, data: { spec: result.spec, specState: "PROPOSED", revision: { increment: 1 } } })] : []),
    ]);
    return state(id, result.text);
  });

  app.post("/api/feedback/:id/confirm", async (request) => {
    const { id } = parse(idParam, request.params);
    if (!(await db.feedback.findUnique({ where: { id }, select: { id: true } }))) throw notFound("That note");
    const { count } = await db.feedback.updateMany({ where: { id, specState: "PROPOSED" }, data: { specState: "CONFIRMED", revision: { increment: 1 } } });
    if (count !== 1) throw new DomainError("There is no proposed spec to confirm", 409);
    return state(id, null);
  });

  app.get("/api/feedback/:id/screenshot", async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const row = await db.feedback.findUnique({ where: { id }, select: { screenshot: true, screenshotType: true } });
    if (!row?.screenshot) throw notFound("That screenshot");
    return reply.header("Content-Type", row.screenshotType ?? "image/jpeg").send(Buffer.from(row.screenshot));
  });

  app.patch("/api/feedback/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const { status } = parse(z.object({ status: z.enum(["OPEN", "DONE", "WONTFIX"]) }), request.body);
    return shape(await db.feedback.update({ where: { id }, data: { status }, select: LIST_FIELDS }));
  });

  /** Everything still open, as Markdown to paste into Claude (or curl from the Dell). */
  app.get("/api/feedback/export.md", async (request, reply) => {
    const { status = "OPEN" } = parse(listQuery, request.query);
    const rows = await db.feedback.findMany({ where: { status }, orderBy: { id: "asc" }, select: { ...LIST_FIELDS, turns: { orderBy: { id: "asc" }, select: { role: true, content: true } } } });
    const origin = `${request.protocol}://${request.headers.host}`;
    const sections = rows.map((row) => {
      const anchor = (row.anchor ?? {}) as { label?: string; selector?: string };
      const ctx = row.context as { viewport?: string; userAgent?: string; build?: string; colorScheme?: string; errors?: { at: string; message: string }[] };
      const lines = [
        `## #${row.id} ${row.kind.toLowerCase()} · \`${row.path}\`${row.pageTitle ? ` (${row.pageTitle})` : ""}`,
        `${row.author}${row.authorJob ? ` (${row.authorJob.toLowerCase()})` : ""} · ${row.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC · ${ctx.viewport ?? "?"} · ${ctx.colorScheme ?? ""} · build ${ctx.build ?? "?"}`,
        "",
        ...row.note.split("\n").map((line) => `> ${line}`),
        "",
      ];
      if (anchor.label || anchor.selector) lines.push(`On: "${anchor.label ?? ""}" \`${anchor.selector ?? ""}\``);
      if (ctx.userAgent) lines.push(`Browser: ${ctx.userAgent}`);
      if (ctx.errors?.length) lines.push("Recent errors:", ...ctx.errors.map((e) => `- ${e.at} ${e.message}`));
      if (row.screenshotType) lines.push(`Screenshot: ${origin}/api/feedback/${row.id}/screenshot`);
      const spec = row.spec as Spec | null;
      if (spec) lines.push("", `Spec (${row.specState.toLowerCase()}):`, `- Problem: ${spec.problem}`, `- Expected: ${spec.expected}`, `- Where: ${spec.where}`, ...spec.doneWhen.map((d) => `- Done when: ${d}`));
      if (row.turns.length) lines.push("", "Chat:", ...row.turns.map((t) => `${t.role === "user" ? "Tester" : "AI"}: ${t.content.replace(/\n/g, " ")}`));
      return lines.join("\n");
    });
    return reply.header("Content-Type", "text/markdown; charset=utf-8").send(`# Feedback (${status.toLowerCase()}, ${rows.length})\n\n${sections.join("\n\n")}\n`);
  });
}
