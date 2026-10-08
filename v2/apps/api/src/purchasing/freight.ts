import { DomainError } from "@pi/domain";
import type { StockCtx } from "../stock";

/** Placeholder until freight bills land (task 23). */
export async function postFreightBill(_ctx: StockCtx, _billId: number, _version: number): Promise<{ totalCents: number }> {
  throw new DomainError("Freight bills are not available yet", 400);
}
