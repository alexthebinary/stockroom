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
export type ClarifyNote = { kind: string; note: string; path: string; pageTitle: string | null; anchorLabel: string; errors: string[] };
export type ClarifyResult = { ok: true; text: string; spec: Spec | null } | { ok: false; reason: "capped" | "error" };
export type Clarifier = { clarify(input: { note: ClarifyNote; turns: Turn[] }): Promise<ClarifyResult> };

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
        const spec = specSchema.safeParse(body.spec);
        return { ok: true, text: body.text.slice(0, 2000), spec: spec.success ? spec.data : null };
      } catch {
        return { ok: false, reason: "error" };
      }
    },
  };
}
