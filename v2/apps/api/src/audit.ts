import type { Tx } from "./db";
import { Prisma } from "./db";

export function audit(tx: Tx, actor: string, action: string, subjectType: string, subjectId: number | null, detail?: unknown) {
  return tx.auditEvent.create({
    data: { actor, action, subjectType, subjectId, detail: detail === undefined ? Prisma.JsonNull : (detail as Prisma.InputJsonValue) },
  });
}
