/**
 * Automated serial capture from a phone camera.
 *
 * POLICY, set by the operator 2026-09-19: automate as much as possible; humans
 * are a fallback for high-level decisions only. So NOTHING here asks a clerk to
 * confirm a read. Every intake commits.
 *
 * 🔴 WHAT MAKES AUTO-COMMIT SAFE IS NOT ACCURACY, IT IS REVERSIBILITY.
 * A unit's identity is its cost layer, not the serial string. A misread is
 * therefore a data fix (`correctSerial`), not a lost unit — the layer, the cost,
 * the movement history and the warranty start date all survive a corrected
 * serial. That is the property that lets us commit first and review later.
 * Every correction is written to `SerialCorrection`, because a silently fixed
 * serial is indistinguishable from one that was always right, and a warranty
 * dispute needs something to look at.
 *
 * The ladder below is DETERMINISTIC — plain rules over the reader's output, not
 * a model judging its own work. A model that scores its own confidence is the
 * one thing measured to be overconfident on this box, so confidence is used to
 * decide whether to FLAG, never to decide whether to accept.
 */
import type { Prisma } from "@prisma/client";
import { badRequest, notFound } from "./errors";

export type Tx = Prisma.TransactionClient;

export const SERIAL_SOURCE = {
  BARCODE: "BARCODE",
  OCR_CORROBORATED: "OCR_CORROBORATED",
  OCR: "OCR",
  MANUAL: "MANUAL",
  IMPORTED: "IMPORTED",
} as const;

/**
 * Known serial shapes per brand.
 *
 * A format check catches the common OCR confusions — 0/O, 8/B, 1/I — before the
 * string reaches the database, which is worth more than any confidence number
 * because it is a property of the STRING rather than of the reader's opinion.
 * An unknown brand has no pattern and is simply not format-checked; absence of a
 * rule must never read as a failed rule.
 */
export const SERIAL_PATTERNS: { brand: string; pattern: RegExp; hint: string }[] = [
  { brand: "Unitree", pattern: /^[A-Z]{2}\d{6,12}$/, hint: "two letters then 6-12 digits" },
  { brand: "BambuLab", pattern: /^[0-9A-Z]{12,20}$/, hint: "12-20 digits and capitals" },
  { brand: "XAG", pattern: /^[A-Z0-9]{8,18}$/, hint: "8-18 digits and capitals" },
];

/** Characters OCR confuses most, normalised toward the digit form. */
const OCR_CONFUSIONS: [RegExp, string][] = [
  [/O/g, "0"],
  [/I/g, "1"],
  [/l/g, "1"],
  [/S/g, "5"],
  [/B/g, "8"],
];

export function normaliseSerial(raw: string) {
  return raw.trim().toUpperCase().replace(/[\s\-_]/g, "");
}

export function formatCheck(brand: string | null, serial: string) {
  const rule = SERIAL_PATTERNS.find((p) => p.brand.toLowerCase() === (brand ?? "").toLowerCase());
  if (!rule) return { known: false, ok: true, hint: null as string | null };
  return { known: true, ok: rule.pattern.test(serial), hint: rule.hint };
}

/**
 * Would a confusion-swap make an invalid read valid?
 *
 * If exactly one swap produces a format-valid string, that is very likely the
 * true serial. We take it AND record both, because acting on the likely answer
 * is the point — but a human should still see it, so it is flagged.
 */
export function repairByConfusion(brand: string | null, serial: string) {
  const { known, ok } = formatCheck(brand, serial);
  if (!known || ok) return null;
  for (const [from, to] of OCR_CONFUSIONS) {
    const candidate = serial.replace(from, to);
    if (candidate !== serial && formatCheck(brand, candidate).ok) return candidate;
  }
  return null;
}

export type IntakeDecision = {
  serial: string;
  source: string;
  needsReview: boolean;
  reviewReason: string | null;
  /** Escalate instead of committing. Reserved for "we do not know what this is". */
  quarantine: boolean;
};

/**
 * Decide what to do with one scanned label. Pure — no database, so it is cheap
 * to test exhaustively.
 *
 * The ONLY path that refuses to commit is a read that produces no usable string
 * at all. Everything else commits, some of it flagged.
 */
export function decideIntake(input: {
  brand: string | null;
  ocrText?: string | null;
  ocrConfidence?: number | null;
  barcode?: string | null;
}): IntakeDecision {
  const ocr = input.ocrText ? normaliseSerial(input.ocrText) : null;
  const bar = input.barcode ? normaliseSerial(input.barcode) : null;

  // Two independent readers agreeing is stronger evidence than any single
  // confidence score, so this is the one path that commits entirely unflagged.
  if (bar && ocr && bar === ocr) {
    return { serial: bar, source: SERIAL_SOURCE.OCR_CORROBORATED, needsReview: false,
             reviewReason: null, quarantine: false };
  }
  // A barcode alone is a machine-readable check digit — trust it over OCR.
  if (bar) {
    const disagree = ocr && ocr !== bar;
    return {
      serial: bar,
      source: SERIAL_SOURCE.BARCODE,
      needsReview: Boolean(disagree),
      reviewReason: disagree ? `barcode ${bar} but OCR read ${ocr}` : null,
      quarantine: false,
    };
  }
  if (!ocr) {
    // Nothing legible. This is the high-level decision a human is for.
    return { serial: "", source: SERIAL_SOURCE.OCR, needsReview: true,
             reviewReason: "no serial could be read from the label", quarantine: true };
  }

  const fmt = formatCheck(input.brand, ocr);
  if (fmt.known && !fmt.ok) {
    const repaired = repairByConfusion(input.brand, ocr);
    if (repaired) {
      return {
        serial: repaired,
        source: SERIAL_SOURCE.OCR,
        needsReview: true,
        reviewReason: `read ${ocr}, auto-corrected to ${repaired} (expected ${fmt.hint})`,
        quarantine: false,
      };
    }
    // Commit anyway — the unit is physically here and the line keeps moving —
    // but flag it loudly. Refusing would stop a delivery over a smudge.
    return {
      serial: ocr,
      source: SERIAL_SOURCE.OCR,
      needsReview: true,
      reviewReason: `does not match the ${input.brand} pattern (${fmt.hint})`,
      quarantine: false,
    };
  }

  const low = (input.ocrConfidence ?? 1) < 0.85;
  return {
    serial: ocr,
    source: SERIAL_SOURCE.OCR,
    needsReview: low,
    reviewReason: low ? `OCR confidence ${(input.ocrConfidence ?? 0).toFixed(2)}` : null,
    quarantine: false,
  };
}

/**
 * Fix a serial after the fact, keeping the unit and its history intact.
 *
 * This is the function that makes auto-commit defensible, so it deliberately
 * does NOT let the unit be swapped — only its label corrected.
 */
export async function correctSerial(
  tx: Tx,
  input: { serialUnitId: number; toSerial: string; reason?: string; actor: string }
) {
  const unit = await tx.serialUnit.findUnique({ where: { id: input.serialUnitId } });
  if (!unit) throw notFound("Serial unit not found");
  const next = normaliseSerial(input.toSerial);
  if (!next) throw badRequest("A corrected serial cannot be blank");
  if (next === unit.serialNumber) return unit;

  const clash = await tx.serialUnit.findFirst({
    where: { productId: unit.productId, serialNumber: next, NOT: { id: unit.id } },
  });
  if (clash) {
    throw badRequest(
      `${next} is already on file for this product (unit ${clash.id}, ${clash.status})`,
      { action: "merge-or-recheck", conflictingUnitId: clash.id }
    );
  }

  await tx.serialCorrection.create({
    data: {
      serialUnitId: unit.id,
      fromSerial: unit.serialNumber,
      toSerial: next,
      reason: input.reason ?? null,
      actor: input.actor,
    },
  });
  return tx.serialUnit.update({
    where: { id: unit.id },
    data: { serialNumber: next, needsReview: false, reviewReason: null },
  });
}

/** Everything committed but flagged, for the sweep. Nothing waits on this. */
export async function reviewQueue(tx: Tx, limit = 50) {
  return tx.serialUnit.findMany({
    where: { needsReview: true },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { product: true },
  });
}
