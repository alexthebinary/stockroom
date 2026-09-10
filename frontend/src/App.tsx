import { AppShell, Burger, Group, Menu, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconAdjustments,
  IconArrowsExchange,
  IconBook2,
  IconBuildingWarehouse,
  IconChartBar,
  IconChevronDown,
  IconLayoutDashboard,
  IconPackage,
  IconReceipt,
  IconStack2,
  IconTruckDelivery,
  IconUsers,
} from "@tabler/icons-react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import Adjustments from "./pages/Adjustments";
import Catalogs from "./pages/Catalogs";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import Ledger from "./pages/Ledger";
import Login from "./pages/Login";
import ProductDetail from "./pages/ProductDetail";
import Products from "./pages/Products";
import PurchaseOrderDetail from "./pages/PurchaseOrderDetail";
import PurchaseOrders from "./pages/PurchaseOrders";
import Reports from "./pages/Reports";
import SalesOrderDetail from "./pages/SalesOrderDetail";
import SalesOrders from "./pages/SalesOrders";
import Transfers from "./pages/Transfers";
import WarehouseDetail from "./pages/WarehouseDetail";
import Warehouses from "./pages/Warehouses";

/**
 * Top-level sections match the scope: Sales, Purchases, Warehouse Management,
 * Reports, Settings. Each is a rail button; the ones with several documents
 * open a menu rather than adding a second level of chrome.
 */
type Section = {
  label: string;
  icon: typeof IconPackage;
  to?: string;
  items?: { to: string; label: string }[];
};

const SECTIONS: Section[] = [
  { label: "Home", icon: IconLayoutDashboard, to: "/" },
  {
    label: "Sales",
    icon: IconReceipt,
    items: [{ to: "/sales-orders", label: "Sales orders" }],
  },
  {
    label: "Purchases",
    icon: IconTruckDelivery,
    items: [{ to: "/purchase-orders", label: "Purchase orders" }],
  },
  {
    label: "Inventory",
    icon: IconStack2,
    items: [
      { to: "/inventory", label: "Stock on hand" },
      { to: "/products", label: "Products" },
      { to: "/warehouses", label: "Warehouses" },
      { to: "/transfers", label: "Transfers" },
      { to: "/adjustments", label: "Adjustments" },
    ],
  },
  { label: "Accounting", icon: IconBook2, to: "/ledger" },
  { label: "Reports", icon: IconChartBar, to: "/reports" },
  { label: "Catalogs", icon: IconUsers, to: "/catalogs" },
];

function RailButton({ section, active }: { section: Section; active: boolean }) {
  const Icon = section.icon;
  const body = (
    <Group gap={6} wrap="nowrap">
      <Icon size={17} stroke={1.7} />
      <Text size="sm" fw={500} visibleFrom="md">
        {section.label}
      </Text>
      {section.items && <IconChevronDown size={13} stroke={2} opacity={0.7} />}
    </Group>
  );

  const style = {
    padding: "7px 11px",
    borderRadius: 6,
    color: active ? "var(--rail-fg)" : "var(--rail-fg-dim)",
    background: active ? "var(--rail-bg-hover)" : "transparent",
    boxShadow: active ? "inset 0 -2px 0 var(--rail-accent)" : undefined,
  };

  if (!section.items) {
    return (
      <UnstyledButton component={NavLink} to={section.to!} style={style}>
        {body}
      </UnstyledButton>
    );
  }

  return (
    <Menu trigger="hover" openDelay={80} closeDelay={120} position="bottom-start" shadow="md">
      <Menu.Target>
        <UnstyledButton style={style}>{body}</UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {section.items.map((item) => (
          <Menu.Item key={item.to} component={NavLink} to={item.to}>
            {item.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

export default function App() {
  const [opened, { toggle }] = useDisclosure();
  const { user, logout } = useAuth();
  const location = useLocation();

  if (!user) return <Login />;

  const isActive = (section: Section) => {
    if (section.to === "/") return location.pathname === "/";
    if (section.to) return location.pathname.startsWith(section.to);
    return (section.items ?? []).some((i) => location.pathname.startsWith(i.to));
  };

  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header
        style={{ background: "var(--rail-bg)", borderBottom: "none", color: "var(--rail-fg)" }}
      >
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" color="var(--rail-fg)" />
            <Text fw={700} size="sm" mr="sm" style={{ letterSpacing: "-0.01em" }}>
              Stockroom
            </Text>
            <Group gap={2} wrap="nowrap" visibleFrom="sm">
              {SECTIONS.map((section) => (
                <RailButton key={section.label} section={section} active={isActive(section)} />
              ))}
            </Group>
          </Group>

          <Menu position="bottom-end" shadow="md">
            <Menu.Target>
              <UnstyledButton style={{ color: "var(--rail-fg-dim)", padding: "6px 8px" }}>
                <Text size="xs">{user.email}</Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{user.name}</Menu.Label>
              <Menu.Item onClick={logout}>Sign out</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

      <AppShell.Main style={{ background: "var(--surface-sunken)" }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/warehouses" element={<Warehouses />} />
          <Route path="/warehouses/:id" element={<WarehouseDetail />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/sales-orders" element={<SalesOrders />} />
          <Route path="/sales-orders/:id" element={<SalesOrderDetail />} />
          <Route path="/purchase-orders" element={<PurchaseOrders />} />
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/adjustments" element={<Adjustments />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/catalogs" element={<Catalogs />} />
          <Route path="*" element={<Text>Page not found.</Text>} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
