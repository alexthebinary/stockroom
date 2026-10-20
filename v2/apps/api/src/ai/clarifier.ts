import { z } from "zod";

/** What a clarified note asks for; written by the clarify Worker, confirmed by the tester. */
export const specSchema = z.object({
  problem: z.string().trim().min(1).max(500),
  expected: z.string().trim().min(1).max(500),
  where: z.string().trim().min(1).max(500),
  doneWhen: z.array(z.string().trim().min(1).max(200)).min(1).max(3),
});
export type Spec = z.infer<typeof specSchema>;
export type Turn = { role: "user" | "assistant"; content: string };
export type ClarifyNote = { kind: string; note: string; path: string; pageTitle: string | null; anchorLabel: string; errors: string[]; previousSpec?: Spec | null };
export type ClarifyResult = { ok: true; text: string; spec: Spec | null } | { ok: false; reason: "capped" | "error" };
export type Clarifier = { clarify(input: { note: ClarifyNote; turns: Turn[]; questionsAsked?: number; finish?: boolean }): Promise<ClarifyResult> };

/** Normalize tool argument shape; never silently remove a requirement. */
export function parseSpec(raw: unknown): Spec | null {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const done = typeof s.doneWhen === "string" ? s.doneWhen.split(/;\s*|\n+/) : s.doneWhen;
  if (!Array.isArray(done) || done.some((d) => typeof d !== "string")) return null;
  const checks = (done as string[]).map((d) => d.trim()).filter(Boolean);
  const grouped = checks.length > 3 ? [...checks.slice(0, 2), checks.slice(2).join("; ")] : checks;
  const parsed = specSchema.safeParse({ ...s, doneWhen: grouped });
  return parsed.success ? parsed.data : null;
}

/** The clarify Worker (Workers AI, free allocation). Off unless CLARIFY_URL and CLARIFY_SECRET are both set. */
export function createClarifier(fetchImpl: typeof fetch = fetch): Clarifier | null {
  const url = process.env.CLARIFY_URL;
  const secret = process.env.CLARIFY_SECRET;
  if (!url || !secret) return null;
  return {
    async clarify(input) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await response.json().catch(() => null)) as { status?: string; text?: unknown; spec?: unknown } | null;
        if (body?.status === "capped") return { ok: false, reason: "capped" };
        if (!response.ok || body?.status !== "ok" || typeof body.text !== "string") return { ok: false, reason: "error" };
        const spec = parseSpec(body.spec);
        if (body.spec != null && !spec) return { ok: false, reason: "error" };
        return { ok: true, text: body.text.slice(0, 2000), spec };
      } catch {
        return { ok: false, reason: "error" };
      }
    },
  };
}

/** Try the primary (the Worker); when it is out, the backup (the Dell's local model). */
export function withFallback(primary: Clarifier | null, backup: Clarifier | null): Clarifier | null {
  if (!primary) return backup;
  if (!backup) return primary;
  return { clarify: async (input) => { const first = await primary.clarify(input); return first.ok ? first : backup.clarify(input); } };
}
