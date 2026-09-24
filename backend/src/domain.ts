export const MOVEMENT_TYPES = [
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "SALE_SHIP",
  "PURCHASE_RECEIPT",
  /// Parts pulled from our own stock onto a repair. A real stock decrease, but
  /// it posts to Repair Parts Expense rather than COGS — no revenue is matched
  /// against it, so folding it into COGS would understate gross margin.
  "REPAIR_CONSUMPTION",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/// Sales orders carry two independent axes, per the scope.
export const READINESS_STATUSES = ["NOT_PACKED", "PACKED", "SHIPPED", "DELIVERED", "CANCELED"] as const;
/// PREPAID: paid in full at checkout, not yet shipped, so the money is a
/// customer deposit and no revenue exists yet. Shipping invoices the order and
/// applies the deposit, which moves it to PAID.
export const SO_PAYMENT_STATUSES = ["AWAITING_PAYMENT", "PREPAID", "INVOICED", "PAID", "VOIDED"] as const;

/// The scope's purchase-order lifecycle, in order.
export const PURCHASE_ORDER_STATUSES = ["SAVED", "POSTED", "PAID", "DELIVERED", "CANCELED"] as const;
export const TRANSFER_STATUSES = ["DRAFT", "IN_TRANSIT", "COMPLETED", "CANCELED"] as const;
export const ADJUSTMENT_TYPES = ["INCREASE", "DECREASE"] as const;

/** Default low-stock threshold used by the dashboard when none is supplied. */
export const LOW_STOCK_THRESHOLD = 10;
