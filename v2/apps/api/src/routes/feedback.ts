import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app";
import { idParam, notFound, parse } from "../http";

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
const LIST_FIELDS = { id: true, kind: true, status: true, note: true, path: true, pageTitle: true, anchor: true, context: true, author: true, authorJob: true, screenshotType: true, createdAt: true, updatedAt: true } as const;

/** Beta feedback: notes pinned to a spot in the app, with what the device knew. */
export function registerFeedback(app: FastifyInstance, { db }: Deps) {
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
      select: { id: true },
    });
    return reply.status(201).send(row);
  });

  app.get("/api/feedback", async (request) => {
    const query = parse(listQuery, request.query);
    const rows = await db.feedback.findMany({ where: query, orderBy: { id: "desc" }, select: LIST_FIELDS });
    return rows.map((row) => ({ ...row, hasScreenshot: row.screenshotType != null }));
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
    return db.feedback.update({ where: { id }, data: { status }, select: LIST_FIELDS });
  });

  /** Everything still open, as Markdown to paste into Claude (or curl from the Dell). */
  app.get("/api/feedback/export.md", async (request, reply) => {
    const { status = "OPEN" } = parse(listQuery, request.query);
    const rows = await db.feedback.findMany({ where: { status }, orderBy: { id: "asc" }, select: LIST_FIELDS });
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
      return lines.join("\n");
    });
    return reply.header("Content-Type", "text/markdown; charset=utf-8").send(`# Feedback (${status.toLowerCase()}, ${rows.length})\n\n${sections.join("\n\n")}\n`);
  });
}
