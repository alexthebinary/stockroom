import { DomainError } from "@pi/domain";
import { postEntry, reverseEntry } from "../ledger";
import { nextNumber } from "../numbering";
import type { StockCtx } from "../stock";
import { refreshPoStatus } from "./po";

const openOf = (b: { totalCents: number; paidCents: number; creditedCents: number }) => b.totalCents - b.paidCents - b.creditedCents;

/**
 * OUT: we pay a bill (Dr AP / Cr Bank), in full or in part, never more than is
 * open. IN: the vendor refunds us after a credit left them owing (Dr Bank /
 * Cr AP), never more than they owe (GAAP guide §II.1 #5, #6, #7).
 */
export async function recordPayment(
  ctx: StockCtx,
  billId: number,
  input: { direction: "OUT" | "IN"; amountCents: number; paidAt: Date; method: string; memo?: string | null },
) {
  const { tx, actor } = ctx;
  // Row lock: two payments of the same bill at once queue rather than both pass the "not more than open" check.
  await tx.$queryRaw`SELECT "id" FROM "VendorBill" WHERE "id" = ${billId} FOR UPDATE`;
  const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: billId } });
  if (bill.status !== "POSTED") throw new DomainError("Only a posted bill can be paid", 409);
  if (input.amountCents <= 0) throw new DomainError("Enter an amount", 400);
  if (input.paidAt.getTime() > Date.now() + 60_000) throw new DomainError("A payment can't be dated in the future", 400);
  const open = openOf(bill);
  if (input.direction === "OUT" && input.amountCents > open) {
    throw new DomainError(open <= 0 ? `${bill.number} has nothing left to pay` : `Only $${(open / 100).toFixed(2)} is open on ${bill.number}`, 409);
  }
  if (input.direction === "IN" && input.amountCents > -open) {
    throw new DomainError(open >= 0 ? `The vendor owes nothing back on ${bill.number}` : `The vendor owes $${(-open / 100).toFixed(2)} back on ${bill.number}`, 409);
  }
  const number = await nextNumber(tx, "PAY");
  const payment = await tx.payment.create({
    data: { number, direction: input.direction, vendorId: bill.vendorId!, billId, amountCents: input.amountCents, method: input.method, paidAt: input.paidAt, memo: input.memo, actor },
  });
  await postEntry(tx, {
    event: input.direction === "OUT" ? "BILL_PAYMENT" : "VENDOR_REFUND",
    date: input.paidAt,
    sourceType: "PAYMENT",
    sourceId: payment.id,
    actor,
    memo: `${number} · ${bill.number}`,
    lines: [
      { role: "payable", amountCents: input.amountCents, vendorId: bill.vendorId! },
      { role: "bank", amountCents: input.amountCents },
    ],
  });
  await tx.vendorBill.update({ where: { id: billId }, data: { paidCents: { increment: input.direction === "OUT" ? input.amountCents : -input.amountCents } } });
  if (bill.poId) await refreshPoStatus(tx, bill.poId);
  return payment;
}

export async function voidPayment(ctx: StockCtx, paymentId: number) {
  const { tx, actor } = ctx;
  const claimed = await tx.payment.updateMany({ where: { id: paymentId, status: "POSTED" }, data: { status: "VOID" } });
  if (claimed.count === 0) throw new DomainError("That payment is already void", 409);
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const entry = await tx.journalEntry.findFirstOrThrow({ where: { sourceType: "PAYMENT", sourceId: paymentId, reversesId: null } });
  await reverseEntry(tx, entry.id, actor);
  const bill = await tx.vendorBill.update({ where: { id: payment.billId }, data: { paidCents: { increment: payment.direction === "OUT" ? -payment.amountCents : payment.amountCents } } });
  if (bill.poId) await refreshPoStatus(tx, bill.poId);
  return payment;
}
