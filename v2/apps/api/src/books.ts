import { State } from "@pi/domain";
import type { Db, Tx } from "./db";

/**
 * Is everything consistent? Run after every test scenario, on demand from the
 * admin home, and before a month is closed. Each check compares two records
 * that are written by different code, so a bug in either shows up here.
 */
export type BooksReport = {
  sound: boolean;
  problems: string[];
  figures: {
    debitsCents: number;
    creditsCents: number;
    onHandGlCents: number;
    onHandPoolCents: number;
    inboundGlCents: number;
    inboundOpenCents: number;
    outboundGlCents: number;
    outboundOpenCents: number;
    payableGlCents: number;
    payableOpenCents: number;
  };
};

export async function checkBooks(db: Db): Promise<BooksReport> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return checkSnapshot(tx);
  }, { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 30_000 });
}

async function checkSnapshot(db: Tx): Promise<BooksReport> {
  const problems: string[] = [];
  const rules = new Map((await db.postingRule.findMany()).map((r) => [r.role, r.accountId]));

  // Inventory is one account (1200); each line's role says which part of it,
  // on hand, billed-in-transit, or shipped-not-invoiced, and each part is proved on its own.
  const lines = await db.journalLine.findMany({ select: { accountId: true, role: true, side: true, amountCents: true, itemId: true, poLineId: true, soLineId: true, vendorId: true } });
  const signed = (l: { side: string; amountCents: number }) => (l.side === "DEBIT" ? l.amountCents : -l.amountCents);

  // 1. Trial balance.
  const debitsCents = lines.filter((l) => l.side === "DEBIT").reduce((s, l) => s + l.amountCents, 0);
  const creditsCents = lines.filter((l) => l.side === "CREDIT").reduce((s, l) => s + l.amountCents, 0);
  if (debitsCents !== creditsCents) problems.push(`Trial balance is off: debits ${debitsCents} ≠ credits ${creditsCents}`);

  // 2. Inventory on hand equals the average-cost pools, item by item.
  const glByItem = new Map<number, number>();
  for (const l of lines.filter((l) => l.role === "inventoryOnHand")) {
    if (l.itemId == null) problems.push("An inventory on-hand line has no item");
    else glByItem.set(l.itemId, (glByItem.get(l.itemId) ?? 0) + signed(l));
  }
  const pools = await db.costPool.findMany();
  const balances = await db.stockBalance.findMany();
  const itemIds = new Set([...glByItem.keys(), ...pools.map((p) => p.itemId)]);
  for (const itemId of itemIds) {
    const gl = glByItem.get(itemId) ?? 0;
    const pool = pools.find((p) => p.itemId === itemId);
    if (gl !== (pool?.valueCents ?? 0)) problems.push(`Item ${itemId}: inventory on hand is ${gl} but its stock is valued at ${pool?.valueCents ?? 0}`);
    const onHand = balances.filter((b) => b.itemId === itemId).reduce((s, b) => s + b.onHand, 0);
    if (onHand !== (pool?.qty ?? 0)) problems.push(`Item ${itemId}: ${onHand} on hand but ${pool?.qty ?? 0} units are costed`);
  }

  // 3. Inventory in transit equals what bills charged and has not landed, PO line by PO line.
  const glByPoLine = new Map<number, number>();
  for (const l of lines.filter((l) => l.role === "inventoryInbound")) {
    if (l.poLineId == null) problems.push("An inventory in-transit line has no PO line");
    else glByPoLine.set(l.poLineId, (glByPoLine.get(l.poLineId) ?? 0) + signed(l));
  }
  const poLines = await db.purchaseOrderLine.findMany({ select: { id: true, inboundCents: true } });
  for (const line of poLines) {
    const gl = glByPoLine.get(line.id) ?? 0;
    if (gl !== line.inboundCents) problems.push(`PO line ${line.id}: inventory in transit is ${gl} but ${line.inboundCents} is billed and not yet landed`);
    if (line.inboundCents < 0) problems.push(`PO line ${line.id}: inbound value is negative`);
  }

  // 3b. Inventory shipped but not yet invoiced equals the cost still on each sales order line.
  const glBySoLine = new Map<number, number>();
  for (const l of lines.filter((l) => l.role === "inventoryOutbound")) {
    if (l.itemId == null) problems.push("An inventory shipped line has no item");
    if (l.soLineId == null) problems.push("An inventory shipped line has no sales order line");
    else glBySoLine.set(l.soLineId, (glBySoLine.get(l.soLineId) ?? 0) + signed(l));
  }
  const soLines = await db.salesOrderLine.findMany({ select: { id: true, qtyShipped: true, qtyCosted: true, shippedValueCents: true, cogsCents: true } });
  const outboundOf = (line: { shippedValueCents: number; cogsCents: number }) => line.shippedValueCents - line.cogsCents;
  const soLineIds = new Set(soLines.map((line) => line.id));
  for (const line of soLines) {
    const gl = glBySoLine.get(line.id) ?? 0;
    const outbound = outboundOf(line);
    if (gl !== outbound) problems.push(`SO line ${line.id}: inventory shipped, not yet invoiced is ${gl} but ${outbound} is the cost of units shipped and not yet invoiced`);
    if (outbound < 0) problems.push(`SO line ${line.id}: inventory shipped, not yet invoiced is negative`);
    if (line.qtyCosted < 0) problems.push(`SO line ${line.id}: costed quantity is negative`);
    if (line.qtyCosted > line.qtyShipped) problems.push(`SO line ${line.id}: ${line.qtyCosted} units are costed but only ${line.qtyShipped} have shipped`);
    if (line.qtyCosted === line.qtyShipped && outbound !== 0) problems.push(`SO line ${line.id}: every shipped unit is costed but ${outbound} remains in inventory shipped, not yet invoiced`);
  }
  for (const [id, gl] of glBySoLine) {
    if (!soLineIds.has(id) && gl !== 0) problems.push(`Sales order line ${id} is on an inventory shipped line but does not exist`);
  }

  // Check the actual accounts too: a non-inventory role may have used one
  // before inventory accounts were reserved in account assignment.
  const inventoryAccounts = await db.account.findMany({ where: { OR: [
    { code: "1200" },
    { id: { in: [rules.get("inventoryOnHand")!, rules.get("inventoryInbound")!, rules.get("inventoryOutbound")!] } },
  ] } });
  for (const account of inventoryAccounts) {
    const actual = lines.filter((l) => l.accountId === account.id).reduce((s, l) => s + signed(l), 0);
    const expected = (rules.get("inventoryOnHand") === account.id ? pools.reduce((s, p) => s + p.valueCents, 0) : 0)
      + (rules.get("inventoryInbound") === account.id ? poLines.reduce((s, l) => s + l.inboundCents, 0) : 0)
      + (rules.get("inventoryOutbound") === account.id ? soLines.reduce((s, l) => s + outboundOf(l), 0) : 0);
    if (actual !== expected) problems.push(`Inventory account ${account.code}: balance is ${actual} but stock, inventory in transit and inventory shipped not yet invoiced total ${expected}`);
  }

  // 4. Stock balances equal the unit registers.
  const movements = await db.stockMovement.groupBy({ by: ["itemId", "warehouseId", "bucket"], _sum: { qtyDelta: true } });
  for (const b of balances) {
    for (const [bucket, qty] of [
      ["ON_HAND", b.onHand],
      ["HELD", b.held],
    ] as const) {
      const registered = movements.find((m) => m.itemId === b.itemId && m.warehouseId === b.warehouseId && m.bucket === bucket)?._sum.qtyDelta ?? 0;
      if (registered !== qty) problems.push(`Item ${b.itemId} at warehouse ${b.warehouseId}: ${bucket} is ${qty} but the registers say ${registered}`);
    }
  }

  // 5. Accounts Payable equals open bills, vendor by vendor.
  const glByVendor = new Map<number, number>();
  for (const l of lines.filter((l) => l.role === "payable")) {
    if (l.vendorId == null) problems.push("An Accounts Payable line has no vendor");
    else glByVendor.set(l.vendorId, (glByVendor.get(l.vendorId) ?? 0) - signed(l));
  }
  const bills = await db.vendorBill.findMany({ where: { status: State.bill.POSTED }, select: { vendorId: true, totalCents: true, paidCents: true, creditedCents: true } });
  const openByVendor = new Map<number, number>();
  for (const b of bills) openByVendor.set(b.vendorId!, (openByVendor.get(b.vendorId!) ?? 0) + b.totalCents - b.paidCents - b.creditedCents);
  for (const vendorId of new Set([...glByVendor.keys(), ...openByVendor.keys()])) {
    const gl = glByVendor.get(vendorId) ?? 0;
    const open = openByVendor.get(vendorId) ?? 0;
    if (gl !== open) problems.push(`Vendor ${vendorId}: Accounts Payable is ${gl} but open bills total ${open}`);
  }

  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    sound: problems.length === 0,
    problems,
    figures: {
      debitsCents,
      creditsCents,
      onHandGlCents: sum(glByItem),
      onHandPoolCents: pools.reduce((s, p) => s + p.valueCents, 0),
      inboundGlCents: sum(glByPoLine),
      inboundOpenCents: poLines.reduce((s, l) => s + l.inboundCents, 0),
      outboundGlCents: sum(glBySoLine),
      outboundOpenCents: soLines.reduce((s, l) => s + outboundOf(l), 0),
      payableGlCents: sum(glByVendor),
      payableOpenCents: sum(openByVendor),
    },
  };
}
