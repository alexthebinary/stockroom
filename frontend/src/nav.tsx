import {
  IconBook2,
  IconBuildingStore,
  IconCalendarCheck,
  IconChartBar,
  IconLayoutDashboard,
  IconReceipt,
  IconSettings,
  IconStack2,
  IconTruckDelivery,
  IconTruckLoading,
  IconWorld,
} from "@tabler/icons-react";
import type { SidebarGroup } from "./components/AppSidebar";

/**
 * The map.
 *
 * Grouped by what the work IS rather than by which table it touches, and each
 * row can say what is waiting on it. `needs` names the server capability the
 * row requires — the backend has enforced stock/money/users across ten route
 * modules since it was written, and the UI offered every destination to every
 * role regardless, so a warehouse picker was invited to a ledger they cannot
 * post to and learned the boundary from a 403.
 */
/** The public Shopify storefront. */
export const STORE_URL = "https://futurology.tech/";

export const NAV: SidebarGroup[] = [
  {
    label: "Operations",
    sections: [
      { label: "Home", icon: IconLayoutDashboard, to: "/" },
      {
        // The counter: a client in the showroom pays and leaves with the goods.
        label: "Store",
        icon: IconBuildingStore,
        to: "/showroom",
        needs: "money",
      },
      {
        label: "Receive",
        icon: IconTruckLoading,
        to: "/receive",
        needs: "stock",
        attention: (a) =>
          a.receipts.ordersShort > 0
            ? { count: a.receipts.ordersShort, tone: "urgent" }
            : null,
      },
      {
        label: "Inventory",
        icon: IconStack2,
        to: "/inventory",
        attention: (a) =>
          a.stock.belowReorderPoint > 0
            ? { count: a.stock.belowReorderPoint, tone: "urgent" }
            : null,
        items: [
          { to: "/inventory", label: "Stock on hand" },
          { to: "/products", label: "Products" },
          { to: "/warehouses", label: "Warehouses" },
          { to: "/transfers", label: "Transfers" },
          { to: "/adjustments", label: "Adjustments" },
        ],
      },
    ],
  },
  {
    label: "Sales",
    sections: [
      {
        label: "Sales",
        icon: IconReceipt,
        to: "/sales-orders",
        attention: (a) =>
          a.invoices.unpaid > 0 ? { count: a.invoices.unpaid, tone: "notice" } : null,
        items: [
          { to: "/sales-orders", label: "Orders" },
          {
            to: "/invoices",
            label: "Invoices",
            attention: (a) =>
              a.invoices.unpaid > 0
                ? { count: a.invoices.unpaid, tone: a.invoices.overdue > 0 ? "urgent" : "notice" }
                : null,
          },
          {
            to: "/deliveries",
            label: "Shipped",
            attention: (a) =>
              a.deliveries.inTransit > 0
                ? { count: a.deliveries.inTransit, tone: "notice" }
                : null,
          },
          { to: "/sales-payments", label: "Payments" },
          { to: "/catalogs/customers", label: "Customers" },
        ],
      },
      {
        label: "Purchases",
        icon: IconTruckDelivery,
        to: "/purchase-orders",
        attention: (a) => (a.bills.unpaid > 0 ? { count: a.bills.unpaid, tone: "notice" } : null),
        items: [
          { to: "/purchase-orders", label: "Orders" },
          {
            to: "/bills",
            label: "Bills",
            attention: (a) =>
              a.bills.unpaid > 0 ? { count: a.bills.unpaid, tone: "notice" } : null,
          },
          { to: "/purchase-payments", label: "Payments" },
          {
            to: "/receipts",
            label: "Receipts",
            attention: (a) =>
              a.receipts.ordersShort > 0
                ? { count: a.receipts.ordersShort, tone: "urgent" }
                : null,
          },
          { to: "/catalogs/vendors", label: "Vendors" },
        ],
      },
    ],
  },
  {
    // The Shopify storefront. It lives outside the app: Shopify orders arrive
    // here as sales orders on the SHOPIFY channel.
    label: "E-commerce",
    sections: [{ label: "Online store", icon: IconWorld, to: STORE_URL, external: true }],
  },
  {
    label: "Finance",
    sections: [
      // Reads are open server-side, so Reports stays visible to everyone.
      // Accounting is money work and is gated to match.
      // The deliverable: a month whose stock and books are proved and locked.
      { label: "Month-end close", icon: IconCalendarCheck, to: "/close" },
      { label: "Accounting", icon: IconBook2, to: "/ledger", needs: "money" },
      {
        label: "Reports",
        icon: IconChartBar,
        to: "/reports",
        items: [
          { to: "/reports/sales", label: "Sales" },
          { to: "/reports/purchases", label: "Purchases" },
          { to: "/reports/stock", label: "Stock on hand" },
          { to: "/reports/valuation", label: "Valuation" },
        ],
      },
    ],
  },
  {
    label: "Configuration",
    sections: [
      {
        label: "Settings",
        icon: IconSettings,
        to: "/catalogs/categories",
        items: [
          { to: "/catalogs/categories", label: "Categories" },
          { to: "/catalogs/employees", label: "Managers" },
          { to: "/catalogs/posting", label: "Posting rules" },
          { to: "/about", label: "About" },
        ],
      },
    ],
  },
];

/** Every destination, flattened — what the command palette searches. */
export const ALL_DESTINATIONS = NAV.flatMap((g) =>
  g.sections.flatMap((s) => [
    { to: s.to, label: s.label, group: g.label, needs: s.needs },
    ...(s.items ?? []).map((i) => ({
      to: i.to,
      label: i.label,
      group: s.label,
      needs: s.needs,
    })),
  ])
);
