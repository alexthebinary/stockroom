/**
 * Adjudicate a label read across several independent readers.
 *
 * POLICY, operator 2026-09-19: put AI in every step and do not spend human
 * labour confirming scans. So a second VISION MODEL, not a clerk, is what
 * confirms the first — and a human is reached only when capture itself fails
 * repeatedly, which is not a judgement call but a broken photo.
 *
 * 🔴 THE ONE THING THAT MAKES DUAL-MODEL AGREEMENT WEAKER THAN IT LOOKS.
 * Two vision models agreeing is NOT two independent observations if they share
 * an architecture, a training corpus or a preprocessing pipeline: a scuffed 8
 * that reads as B to one model reads as B to its cousin, confidently, and the
 * agreement manufactures certainty rather than measuring it. Correlated error
 * is invisible from inside the system — it looks exactly like corroboration.
 *
 * So:
 *   - readers MUST declare a `family`, and agreement across the SAME family is
 *     scored as ONE reader, not two;
 *   - a barcode is a different KIND of evidence (a check-digited machine read),
 *     so it outranks any number of agreeing vision models;
 *   - format validity is checked independently of every reader, because it is a
 *     property of the string rather than of anyone's opinion.
 *
 * Nothing here calls a model. Readers are passed in, so the ladder is pure and
 * exhaustively testable, and swapping model lanes cannot change the policy.
 */
import { formatCheck, normaliseSerial, repairByConfusion, SERIAL_SOURCE } from "./serial_intake";

export type Reader = {
  /** Model or device identity, for the audit trail. */
  id: string;
  /** Architecture family. Same family == correlated, so it counts once. */
  family: string;
  text: string | null;
  confidence?: number | null;
};

export type Adjudication = {
  serial: string;
  source: string;
  /** Distinct FAMILIES that produced the winning string. */
  agreement: number;
  needsReview: boolean;
  reviewReason: string | null;
  /** Ask the device to shoot again. Not a human decision — a failed capture. */
  retry: boolean;
  /** Only after retries are exhausted does a person get involved. */
  escalate: boolean;
  evidence: string;
};

export const MAX_CAPTURE_ATTEMPTS = 3;

export function adjudicate(input: {
  brand: string | null;
  barcode?: string | null;
  readers: Reader[];
  attempt?: number;
}): Adjudication {
  const attempt = input.attempt ?? 1;
  const bar = input.barcode ? normaliseSerial(input.barcode) : null;

  const reads = input.readers
    .map((r) => ({ ...r, value: r.text ? normaliseSerial(r.text) : null }))
    .filter((r) => r.value);

  // Group by string, counting DISTINCT FAMILIES rather than readers.
  const byValue = new Map<string, Set<string>>();
  for (const r of reads) {
    if (!byValue.has(r.value!)) byValue.set(r.value!, new Set());
    byValue.get(r.value!)!.add(r.family);
  }

  // A barcode is a different kind of evidence and wins outright.
  if (bar) {
    const models = byValue.get(bar)?.size ?? 0;
    const dissent = [...byValue.keys()].filter((v) => v !== bar);
    return {
      serial: bar,
      source: models > 0 ? SERIAL_SOURCE.OCR_CORROBORATED : SERIAL_SOURCE.BARCODE,
      agreement: models + 1,
      needsReview: dissent.length > 0,
      reviewReason: dissent.length ? `barcode ${bar}; vision read ${dissent.join(", ")}` : null,
      retry: false,
      escalate: false,
      evidence: `barcode + ${models} vision famil${models === 1 ? "y" : "ies"}`,
    };
  }

  if (byValue.size === 0) {
    // No reader produced anything. A retry is free and usually works — a
    // different angle, better light. Only a repeatedly failed capture is a
    // person's problem, and even then it is "this label is unreadable", not a
    // judgement about inventory.
    const exhausted = attempt >= MAX_CAPTURE_ATTEMPTS;
    return {
      serial: "", source: SERIAL_SOURCE.OCR, agreement: 0,
      needsReview: true,
      reviewReason: exhausted
        ? `no reader could read the label after ${attempt} attempts`
        : `nothing legible on attempt ${attempt}`,
      retry: !exhausted, escalate: exhausted,
      evidence: "no legible read",
    };
  }

  // Rank: most independent families, then format validity, then confidence.
  const scored = [...byValue.entries()].map(([value, families]) => {
    const fmt = formatCheck(input.brand, value);
    const conf = Math.max(
      ...reads.filter((r) => r.value === value).map((r) => r.confidence ?? 0)
    );
    return { value, families: families.size, formatOk: fmt.ok, known: fmt.known, conf };
  });
  scored.sort((a, b) =>
    b.families - a.families ||
    Number(b.formatOk) - Number(a.formatOk) ||
    b.conf - a.conf
  );
  const top = scored[0];
  const contested = scored.length > 1;

  // Independent families agreeing on a format-valid string is the strongest
  // evidence available without a barcode, and commits unflagged.
  if (top.families >= 2 && top.formatOk && !contested) {
    return {
      serial: top.value, source: SERIAL_SOURCE.OCR_CORROBORATED, agreement: top.families,
      needsReview: false, reviewReason: null, retry: false, escalate: false,
      evidence: `${top.families} independent vision families agreed`,
    };
  }

  // Agreement across families, but somebody dissented — take the agreed string
  // and keep the dissent visible.
  if (top.families >= 2 && top.formatOk && contested) {
    const others = scored.slice(1).map((s) => s.value).join(", ");
    return {
      serial: top.value, source: SERIAL_SOURCE.OCR_CORROBORATED, agreement: top.families,
      needsReview: true, reviewReason: `agreed ${top.value}; dissent: ${others}`,
      retry: false, escalate: false,
      evidence: `${top.families} families agreed, ${scored.length - 1} dissented`,
    };
  }

  // A single family, or no format-valid candidate. Try the confusion repair
  // before flagging — it is deterministic and usually right.
  if (top.known && !top.formatOk) {
    const repaired = repairByConfusion(input.brand, top.value);
    if (repaired) {
      return {
        serial: repaired, source: SERIAL_SOURCE.OCR, agreement: top.families,
        needsReview: true,
        reviewReason: `read ${top.value}, auto-corrected to ${repaired}`,
        retry: false, escalate: false,
        evidence: `single-family read, repaired by confusion rule`,
      };
    }
    // Retry once on a bad format before accepting it — a second photo is
    // cheaper than a wrong serial, and costs no human time.
    if (attempt < MAX_CAPTURE_ATTEMPTS) {
      return {
        serial: top.value, source: SERIAL_SOURCE.OCR, agreement: top.families,
        needsReview: true, reviewReason: `format mismatch on attempt ${attempt}`,
        retry: true, escalate: false,
        evidence: "format mismatch, retrying",
      };
    }
  }

  const low = top.conf > 0 && top.conf < 0.85;
  return {
    serial: top.value, source: SERIAL_SOURCE.OCR, agreement: top.families,
    needsReview: top.families < 2 || low || contested,
    reviewReason:
      contested ? `readers disagreed: ${scored.map((s) => s.value).join(" vs ")}`
      : top.families < 2 ? "only one reader family produced this"
      : low ? `confidence ${top.conf.toFixed(2)}`
      : null,
    retry: false, escalate: false,
    evidence: `${top.families} famil${top.families === 1 ? "y" : "ies"}, format ${top.formatOk ? "ok" : "unrecognised"}`,
  };
}
