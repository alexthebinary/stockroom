export const MOVEMENT_TYPES = [
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "SALE_SHIP",
  "PURCHASE_RECEIPT",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/// Sales orders carry two independent axes, per the scope.
export const READINESS_STATUSES = ["NOT_PACKED", "PACKED", "SHIPPED", "CANCELED"] as const;
export const SO_PAYMENT_STATUSES = ["AWAITING_PAYMENT", "INVOICED", "PAID", "VOIDED"] as const;

/// The scope's purchase-order lifecycle, in order.
export const PURCHASE_ORDER_STATUSES = ["SAVED", "POSTED", "PAID", "DELIVERED", "CANCELED"] as const;
export const TRANSFER_STATUSES = ["DRAFT", "IN_TRANSIT", "COMPLETED", "CANCELED"] as const;
export const ADJUSTMENT_TYPES = ["INCREASE", "DECREASE"] as const;

/** Default low-stock threshold used by the dashboard when none is supplied. */
export const LOW_STOCK_THRESHOLD = 10;
