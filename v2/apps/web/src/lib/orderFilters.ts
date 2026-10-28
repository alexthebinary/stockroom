import type { PurchaseOrder } from "./types";

// Wording matches StatusBadge and ReceivingBadge; PARTIAL has a different meaning on each axis.
export const orderFilterOptions = {
  billingStatus: [{ value: "NOT_BILLED", label: "Not billed" }, { value: "DRAFT", label: "Draft" }, { value: "BILLED", label: "Billed" }],
  paymentStatus: [{ value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Part paid" }, { value: "PAID", label: "Paid" }],
  receivingStatus: [{ value: "NOT_RECEIVED", label: "Not received" }, { value: "PARTIAL", label: "Part received" }, { value: "RECEIVED", label: "Received" }],
  lifecycle: [{ value: "OPEN", label: "Open" }, { value: "ALL", label: "All" }, { value: "CLOSED", label: "Closed / cancelled" }],
};

export const orderFilterKeys = ["search", "vendorId", "billingStatus", "paymentStatus", "receivingStatus", "lifecycle", "from", "to"] as const;
export type OrderFilterKey = typeof orderFilterKeys[number];

export function readOrderFilters(params: URLSearchParams): Record<OrderFilterKey, string> {
  const choice = (key: keyof typeof orderFilterOptions, fallback = "") =>
    orderFilterOptions[key].some((option) => option.value === params.get(key)) ? params.get(key)! : fallback;
  return {
    search: params.get("search") ?? "",
    vendorId: params.get("vendorId") ?? "",
    billingStatus: choice("billingStatus"),
    paymentStatus: choice("paymentStatus"),
    receivingStatus: choice("receivingStatus"),
    lifecycle: choice("lifecycle", "OPEN"),
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
}

/** Calendar days are local to the person viewing the list, including the entire final day. */
export function filterOrders(orders: PurchaseOrder[], filters: Record<OrderFilterKey, string>): PurchaseOrder[] {
  const search = filters.search.trim().toLowerCase();
  const from = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : NaN;
  const until = filters.to ? new Date(`${filters.to}T00:00:00`) : null;
  until?.setDate(until.getDate() + 1);
  const end = until?.getTime() ?? NaN;
  return orders.filter((po) => {
    if (filters.lifecycle === "OPEN" && po.lifecycle !== "OPEN") return false;
    if (filters.lifecycle === "CLOSED" && po.lifecycle !== "CLOSED" && po.lifecycle !== "CANCELED") return false;
    if (filters.vendorId && String(po.vendorId) !== filters.vendorId) return false;
    if (filters.billingStatus && po.billingStatus !== filters.billingStatus) return false;
    if (filters.paymentStatus && po.paymentStatus !== filters.paymentStatus) return false;
    if (filters.receivingStatus && po.receivingStatus !== filters.receivingStatus) return false;
    const created = new Date(po.createdAt).getTime();
    if (!Number.isNaN(from) && created < from) return false;
    if (!Number.isNaN(end) && created >= end) return false;
    return !search || [po.number, po.vendor?.name, ...po.lines.flatMap((line) => [line.item?.sku, line.item?.name])]
      .some((value) => value?.toLowerCase().includes(search));
  });
}
