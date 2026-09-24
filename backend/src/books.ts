import { prisma } from "./db";
import { ACCOUNT } from "./accounts";
import { balanceOf } from "./ledger";

/**
 * The trial balance and the four soundness checks that can genuinely fail.
 * Shared by GET /api/trial-balance and the month-end close, so the close
 * cannot pass a check the ledger page would fail.
 */
export async function trialBalance(asOf = "") {
  const entryWhere = {
    status: "POSTED",
    ...(asOf ? { entryDate: { lte: new Date(`${asOf}T23:59:59.999Z`) } } : {}),
  };

  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: entryWhere },
    include: { account: true, journalEntry: { select: { id: true, entryNumber: true } } },
  });

  const byAccount = new Map<
    number,
    { code: string; name: string; accountType: string; normalSide: string; debitCents: number; creditCents: number }
  >();
  // Per-entry totals, so each entry can be re-proved on its own.
  const byEntry = new Map<number, { entryNumber: string; debitCents: number; creditCents: number }>();

  for (const line of lines) {
    const account =
      byAccount.get(line.accountId) ??
      {
        code: line.account.code,
        name: line.account.name,
        accountType: line.account.accountType,
        normalSide: line.account.normalSide,
        debitCents: 0,
        creditCents: 0,
      };
    account.debitCents += line.debitCents;
    account.creditCents += line.creditCents;
    byAccount.set(line.accountId, account);

    const entry =
      byEntry.get(line.journalEntry.id) ??
      { entryNumber: line.journalEntry.entryNumber, debitCents: 0, creditCents: 0 };
    entry.debitCents += line.debitCents;
    entry.creditCents += line.creditCents;
    byEntry.set(line.journalEntry.id, entry);
  }

  const accounts = [...byAccount.values()]
    .map((a) => ({ ...a, balanceCents: balanceOf(a.normalSide, a) }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const unbalancedEntries = [...byEntry.entries()]
    .filter(([, e]) => e.debitCents !== e.creditCents)
    .map(([id, e]) => ({
      id,
      entryNumber: e.entryNumber,
      debitCents: e.debitCents,
      creditCents: e.creditCents,
    }));

  const totalFor = (types: string[]) =>
    accounts.filter((a) => types.includes(a.accountType)).reduce((s, a) => s + a.balanceCents, 0);

  const assetsCents = totalFor(["ASSET"]);
  const liabilitiesCents = totalFor(["LIABILITY"]);
  const equityCents = totalFor(["EQUITY"]);
  const incomeCents = totalFor(["INCOME"]);
  const expensesCents = totalFor(["EXPENSE"]);

  // Assets = Liabilities + Equity + Income - Expenses
  const equationVarianceCents =
    assetsCents - (liabilitiesCents + equityCents + incomeCents - expensesCents);

  const totalDebitCents = accounts.reduce((s, a) => s + a.debitCents, 0);
  const totalCreditCents = accounts.reduce((s, a) => s + a.creditCents, 0);

  // An account typed one way and signed the other inverts its whole balance.
  const EXPECTED_SIDE: Record<string, string> = {
    ASSET: "DEBIT",
    EXPENSE: "DEBIT",
    LIABILITY: "CREDIT",
    EQUITY: "CREDIT",
    INCOME: "CREDIT",
  };
  const allAccounts = await prisma.account.findMany({ orderBy: { code: "asc" } });
  const chartInconsistencies = allAccounts
    .filter((a) => EXPECTED_SIDE[a.accountType] && EXPECTED_SIDE[a.accountType] !== a.normalSide)
    .map((a) => ({
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      normalSide: a.normalSide,
      expectedSide: EXPECTED_SIDE[a.accountType],
    }));

  // A reversal whose original is gone moves the books with no explanation.
  const reversals = await prisma.journalEntry.findMany({
    where: { transactionType: { endsWith: "_REVERSAL" }, status: "POSTED" },
  });
  const orphanedReversals: { entryNumber: string; transactionType: string }[] = [];
  for (const r of reversals) {
    const originalType = r.transactionType.replace(/_REVERSAL$/, "");
    const original = await prisma.journalEntry.findFirst({
      where: {
        transactionType: originalType,
        referenceType: r.referenceType,
        referenceId: r.referenceId,
      },
    });
    if (!original) {
      orphanedReversals.push({ entryNumber: r.entryNumber, transactionType: r.transactionType });
    }
  }

  /**
   * An entry that was posted and is now unposted has left the books while
   * the document it belongs to still claims to be posted. Every total above
   * is computed over POSTED entries only, so the money simply vanishes from
   * this report with nothing flagging it. This is the check that catches it.
   */
  const withdrawnEntries = (
    await prisma.journalEntry.findMany({
      where: { hasBeenPosted: true, status: { not: "POSTED" } },
      select: { id: true, entryNumber: true, status: true, transactionType: true, referenceType: true },
    })
  ).map((e) => ({ ...e }));

  return {
    asOf: asOf || null,
    accounts,
    totalDebitCents,
    totalCreditCents,
    entryCount: byEntry.size,
    unbalancedEntries,
    assetsCents,
    liabilitiesCents,
    equityCents,
    incomeCents,
    expensesCents,
    /**
     * Reported for the reader, NOT relied on: this is algebraically the same
     * number as totalDebits - totalCredits, so it cannot fail on its own.
     */
    equationVarianceCents,
    chartInconsistencies,
    orphanedReversals,
    withdrawnEntries,
    /** True only when the four checks that can actually fail all pass. */
    sound:
      unbalancedEntries.length === 0 &&
      chartInconsistencies.length === 0 &&
      orphanedReversals.length === 0 &&
      withdrawnEntries.length === 0,
    /** Retained for compatibility; an alias of `sound`. */
    balanced:
      unbalancedEntries.length === 0 &&
      chartInconsistencies.length === 0 &&
      orphanedReversals.length === 0 &&
      withdrawnEntries.length === 0,
  };
}

/**
 * Stock value from the open FIFO layers (plus goods in transit), reconciled
 * against the Inventory account. Shared by the valuation report and the close.
 */
export async function inventoryValuation() {
  const lots = await prisma.inventoryLot.findMany({
    where: { remainingQty: { gt: 0 } },
    include: { product: true, warehouse: true },
  });

  const byProduct = new Map<
    string,
    { sku: string; name: string; warehouseCode: string; quantity: number; valueCents: number; layers: number }
  >();

  for (const lot of lots) {
    const key = `${lot.productId}:${lot.warehouseId}`;
    const row =
      byProduct.get(key) ??
      {
        sku: lot.product.sku,
        name: lot.product.name,
        warehouseCode: lot.warehouse.code,
        quantity: 0,
        valueCents: 0,
        layers: 0,
      };
    row.quantity += lot.remainingQty;
    row.valueCents += lot.remainingQty * lot.unitCostCents;
    row.layers += 1;
    byProduct.set(key, row);
  }

  const rows = [...byProduct.values()].sort((a, b) => b.valueCents - a.valueCents);
  const layerValueCents = rows.reduce((s, r) => s + r.valueCents, 0);

  const inventoryAccount = await prisma.account.findUnique({ where: { code: ACCOUNT.INVENTORY } });
  let ledgerValueCents = 0;
  if (inventoryAccount) {
    const lines = await prisma.journalLine.findMany({
      where: { accountId: inventoryAccount.id, journalEntry: { status: "POSTED" } },
    });
    ledgerValueCents = lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  }

  // Stock in transit has left its source layers but not yet arrived at the
  // destination, so it is owned by neither warehouse while still being an
  // asset on the books. Counting it is the difference between a real
  // reconciliation and one that cries wolf during every transfer.
  const inTransit = await prisma.stockTransfer.findMany({
    where: { status: "IN_TRANSIT" },
    select: { costCents: true },
  });
  const inTransitCents = inTransit.reduce((s, t) => s + t.costCents, 0);
  const assetValueCents = layerValueCents + inTransitCents;

  return {
    rows,
    layerValueCents,
    inTransitCents,
    assetValueCents,
    ledgerValueCents,
    varianceCents: assetValueCents - ledgerValueCents,
    reconciled: assetValueCents === ledgerValueCents,
  };
}
