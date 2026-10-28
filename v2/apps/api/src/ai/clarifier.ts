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

/** A final_spec written as text: `<arg_key>k</arg_key><arg_value>v</arg_value>` pairs. Only a complete, valid one counts. */
export function specFromMarkup(text: string) {
  const args: Record<string, unknown> = {};
  for (const [, key, value] of text.matchAll(/<arg_key>\s*([\w]+)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)) args[key!] = value!.trim();
  if (typeof args.doneWhen === "string" && args.doneWhen.startsWith("[")) { try { args.doneWhen = JSON.parse(args.doneWhen); } catch { /* split on ; below */ } }
  return parseSpec(args);
}

/** Some models write the tool call out as text. Never show it: keep the words before it, and take a complete spec from it. */
export function stripToolMarkup(text: string, spec: Spec | null): { text: string; spec: Spec | null; hadMarkup: boolean } {
  const at = text.search(/<tool_call>|<arg_key>|<\/?arg_value>/);
  if (at < 0) return { text, spec, hadMarkup: false };
  return { text: text.slice(0, at).trim(), spec: spec ?? specFromMarkup(text.slice(at)), hadMarkup: true };
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
        const parsed = parseSpec(body.spec);
        if (body.spec != null && !parsed) return { ok: false, reason: "error" };
        const clean = stripToolMarkup(body.text, parsed);
        if (clean.hadMarkup && !clean.spec) return { ok: false, reason: "error" };
        return { ok: true, text: (clean.text || "Here is what I understood. Please confirm it.").slice(0, 2000), spec: clean.spec };
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
