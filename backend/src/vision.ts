/**
 * Read a label with two independent vision models.
 *
 * Provider-agnostic on purpose: any OpenAI-compatible chat endpoint that accepts
 * an image works, so the models can be swapped without touching the policy in
 * vision_adjudicate.ts. Configure two from DIFFERENT families — agreement
 * between cousins is not corroboration.
 *
 *   VISION_A_URL / VISION_A_KEY / VISION_A_MODEL / VISION_A_FAMILY
 *   VISION_B_URL / VISION_B_KEY / VISION_B_MODEL / VISION_B_FAMILY
 *
 * With nothing configured this returns no readers rather than failing, so the
 * dock still works off the barcode alone.
 */
import type { Reader } from "./vision_adjudicate";

const PROMPT =
  "Read the serial number printed on this shipping label. " +
  "Reply with ONLY the serial number, no words, no punctuation, no explanation. " +
  "If no serial number is legible, reply with exactly: NONE";

type Cfg = { url: string; key: string; model: string; family: string; id: string };

function config(slot: "A" | "B"): Cfg | null {
  const url = process.env[`VISION_${slot}_URL`];
  const model = process.env[`VISION_${slot}_MODEL`];
  if (!url || !model) return null;
  return {
    url,
    key: process.env[`VISION_${slot}_KEY`] ?? "",
    model,
    // Family defaults to the model name, which is SAFER than defaulting to a
    // shared constant: two unconfigured families would look independent.
    family: process.env[`VISION_${slot}_FAMILY`] ?? model,
    id: `${slot}:${model}`,
  };
}

async function readOne(cfg: Cfg, imageDataUrl: string, timeoutMs = 12_000): Promise<Reader> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 32,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) return { id: cfg.id, family: cfg.family, text: null };
    const body = (await res.json()) as any;
    const raw: string = body?.choices?.[0]?.message?.content ?? "";
    const text = raw.trim();
    return {
      id: cfg.id,
      family: cfg.family,
      text: !text || text.toUpperCase() === "NONE" ? null : text,
      // No confidence is reported by a chat completion, and inventing one would
      // be worse than none — the adjudicator treats absent confidence as "do
      // not use confidence", which is the honest reading.
      confidence: null,
    };
  } catch {
    // A reader that times out is a MISSING observation, not a negative one.
    return { id: cfg.id, family: cfg.family, text: null };
  } finally {
    clearTimeout(t);
  }
}

/** Both readers in parallel — a second opinion must not double the wait. */
export async function readLabel(imageDataUrl: string): Promise<Reader[]> {
  const cfgs = [config("A"), config("B")].filter(Boolean) as Cfg[];
  if (!cfgs.length) return [];
  return Promise.all(cfgs.map((c) => readOne(c, imageDataUrl)));
}

export function visionConfigured() {
  return [config("A"), config("B")].filter(Boolean).length;
}
