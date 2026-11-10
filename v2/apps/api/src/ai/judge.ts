import { readFileSync } from "node:fs";
import { Prisma } from "../db";

/**
 * One typed choice from TypeSafe Jev, written to AiJudgment when the call succeeds.
 * Jev cannot write text: it only picks one of the criteria, plus none. Any failure,
 * timeout or missing key returns null and writes nothing.
 */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const NONE = "none";

export type Band = "HIGH" | "MEDIUM" | "NONE";

export type JudgeInput = {
  key: string;
  subject: string;
  state: Record<string, unknown>;
  instructions: string;
  criteria: Record<string, string>;
  timeoutMs?: number;
  actor?: string | null;
};

export type JudgeResult = {
  id: number;
  choice: string;
  confidence: number;
  band: Band;
  probabilities: Record<string, number>;
};

type JudgmentCreate = {
  question: string;
  subject: string;
  suggestion: Prisma.InputJsonValue;
  band: string;
  actor: string | null;
  latencyMs: number;
  model: string;
};

export type JudgeDb = {
  aiJudgment: {
    create(args: { data: JudgmentCreate }): Promise<{ id: number }>;
  };
};

export type JudgeDeps = {
  fetch: typeof fetch;
  apiKey: string | null | undefined;
  db: JudgeDb;
};

type ChoiceAnswer = { type: string; choice?: unknown; confidence?: unknown; probabilities?: unknown };

/** HIGH at 0.8 and above, MEDIUM at 0.5 and above, otherwise NONE. */
export function bandOf(confidence: number): Band {
  if (confidence >= 0.8) return "HIGH";
  if (confidence >= 0.5) return "MEDIUM";
  return "NONE";
}

/** Env first, then ~/.config/typesafe/key. Never logs the key. Empty means absent. */
export function readTypesafeKey(): string | null {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(`${process.env.HOME}/.config/typesafe/key`, "utf8").trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

export async function judge(input: JudgeInput, deps: JudgeDeps): Promise<JudgeResult | null> {
  const apiKey = deps.apiKey?.trim();
  if (!apiKey) return null;
  const criteria = { ...input.criteria };
  if (!criteria[NONE]) criteria[NONE] = "None of the other options.";
  const started = Date.now();
  try {
    const response = await deps.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 1500),
      body: JSON.stringify({
        model: "jev-latest",
        state: input.state,
        questions: {
          [input.key]: { type: "choice", instructions: input.instructions, criteria },
        },
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { model?: unknown; answers?: Record<string, ChoiceAnswer> };
    const answer = body.answers?.[input.key];
    if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) return null;
    const probabilities = probabilitiesOf(answer.probabilities);
    const band = bandOf(answer.confidence);
    const row = await deps.db.aiJudgment.create({
      data: {
        question: input.key,
        subject: input.subject,
        suggestion: { choice: answer.choice, confidence: answer.confidence, probabilities, candidates: criteria },
        band,
        actor: input.actor ?? null,
        latencyMs: Date.now() - started,
        model: typeof body.model === "string" && body.model ? body.model : "jev-latest",
      },
    });
    return { id: row.id, choice: answer.choice, confidence: answer.confidence, band, probabilities };
  } catch {
    return null;
  }
}

function probabilitiesOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (typeof probability === "number" && Number.isFinite(probability)) out[key] = probability;
  }
  return out;
}
