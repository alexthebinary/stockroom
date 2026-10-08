import type { Tx } from "./db";

/** Document number formats, as people read them on paper and on screen. */
const FORMATS = {
  PO: (n: number) => `PO-${String(n).padStart(5, "0")}`,
  BILL: (n: number) => `BILL-${String(n).padStart(5, "0")}`,
  WH_IN: (n: number) => `WH-IN-${String(n).padStart(5, "0")}`,
  WH_OUT: (n: number) => `WH-OUT-${String(n).padStart(5, "0")}`,
  ADJ: (n: number) => `ADJ-${String(n).padStart(5, "0")}`,
  JE: (n: number) => `JE-${String(n).padStart(6, "0")}`,
  PAY: (n: number) => `PAY-${String(n).padStart(5, "0")}`,
  VC: (n: number) => `VC-${String(n).padStart(5, "0")}`,
} as const;

export type DocumentKind = keyof typeof FORMATS;

/** Atomic in one statement, so two people saving at once never share a number. */
export async function nextNumber(tx: Tx, kind: DocumentKind): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO "DocumentCounter" ("kind", "next") VALUES (${kind}, 2)
    ON CONFLICT ("kind") DO UPDATE SET "next" = "DocumentCounter"."next" + 1
    RETURNING "next" - 1 AS n`;
  return FORMATS[kind](Number(row!.n));
}
