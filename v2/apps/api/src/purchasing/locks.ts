import { Prisma, type Tx } from "../db";

/** Lock every affected line before reading quantities, in one stable order. */
export async function lockPoLines(tx: Tx, ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrderLine"
    WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`;
}
