import { AppShell, Box, Burger, Group, Menu, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBook2,
  IconChartBar,
  IconInfoCircle,
  IconLayoutDashboard,
  IconPackage,
  IconReceipt,
  IconStack2,
  IconTruckDelivery,
  IconUsers,
} from "@tabler/icons-react";
import { useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import About from "./pages/About";
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
 * Navigation is two fixed rows, not a row of menus.
 *
 * The top row is the section; the row beneath it is that section's pages, and
 * it is always visible for as long as you are inside the section. A hover menu
 * hid those pages behind a gesture that does not exist on touch, and it meant
 * the set of places you could go changed depending on where the pointer was.
 *
 * A section whose landing page IS the section (Home, Accounting, About) has no
 * second row — it would be a row with one item in it.
 */
type Section = {
  label: string;
  icon: typeof IconPackage;
  to: string;
  items?: { to: string; label: string }[];
};

const SECTIONS: Section[] = [
  { label: "Home", icon: IconLayoutDashboard, to: "/" },
  { label: "Sales", icon: IconReceipt, to: "/sales-orders" },
  { label: "Purchases", icon: IconTruckDelivery, to: "/purchase-orders" },
  {
    label: "Inventory",
    icon: IconStack2,
    to: "/inventory",
    items: [
      { to: "/inventory", label: "Stock on hand" },
      { to: "/products", label: "Products" },
      { to: "/warehouses", label: "Warehouses" },
      { to: "/transfers", label: "Transfers" },
      { to: "/adjustments", label: "Adjustments" },
    ],
  },
  { label: "Accounting", icon: IconBook2, to: "/ledger" },
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
  {
    label: "Catalogs",
    icon: IconUsers,
    to: "/catalogs",
    items: [
      { to: "/catalogs/customers", label: "Customers" },
      { to: "/catalogs/vendors", label: "Vendors" },
      { to: "/catalogs/employees", label: "Managers" },
      { to: "/catalogs/categories", label: "Categories" },
      { to: "/catalogs/posting", label: "Posting rules" },
    ],
  },
  { label: "About", icon: IconInfoCircle, to: "/about" },
];

/**
 * Inventory's pages live at unrelated top-level paths (/products, /transfers),
 * so the section cannot be inferred from the URL prefix alone.
 */
function sectionFor(pathname: string): Section | undefined {
  if (pathname === "/") return SECTIONS[0];
  const withItems = SECTIONS.filter((s) => s.items).find((s) =>
    s.items!.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
  );
  if (withItems) return withItems;
  return SECTIONS.filter((s) => s.to !== "/").find(
    (s) => pathname === s.to || pathname.startsWith(`${s.to}/`)
  );
}

const RAIL_H = 52;
const SUB_H = 44;

function SectionButton({ section, active }: { section: Section; active: boolean }) {
  const Icon = section.icon;
  return (
    <UnstyledButton
      component={NavLink}
      to={section.to}
      className="rail-link"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} stroke={1.8} />
      <Text span size="sm" fw={510} visibleFrom="md">
        {section.label}
      </Text>
    </UnstyledButton>
  );
}

export default function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const { user, logout } = useAuth();
  const location = useLocation();
  const section = sectionFor(location.pathname);
  const subItems = section?.items;

  // A route change from inside the drawer must close it, or the next page
  // renders underneath an open overlay.
  useEffect(close, [location.pathname, close]);

  if (!user) return <Login />;

  return (
    <AppShell
      header={{ height: subItems ? RAIL_H + SUB_H : RAIL_H }}
      navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: !opened, desktop: true } }}
      padding="lg"
    >
      <AppShell.Header className="app-header">
        <Box className="rail" h={RAIL_H}>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              <Burger
                opened={opened}
                onClick={toggle}
                hiddenFrom="sm"
                size="sm"
                color="var(--rail-fg)"
                aria-label="Navigation"
              />
              <Text fw={680} size="sm" mr="sm" className="wordmark">
                Stockroom
              </Text>
              <Group gap={2} wrap="nowrap" visibleFrom="sm">
                {SECTIONS.map((s) => (
                  <SectionButton key={s.label} section={s} active={s === section} />
                ))}
              </Group>
            </Group>

            <Menu position="bottom-end" shadow="md" radius="md">
              <Menu.Target>
                <UnstyledButton className="rail-account">
                  <Text span size="xs">
                    {user.email}
                  </Text>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.name}</Menu.Label>
                <Menu.Item onClick={logout}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Box>

        {subItems && (
          <Box component="nav" className="subrail" h={SUB_H} aria-label={`${section!.label} pages`}>
            <ScrollArea type="never" h="100%">
              <Group h={SUB_H} px="md" gap={2} wrap="nowrap">
                {subItems.map((item) => (
                  <UnstyledButton
                    key={item.to}
                    component={NavLink}
                    to={item.to}
                    className="subrail-link"
                    end
                  >
                    {item.label}
                  </UnstyledButton>
                ))}
              </Group>
            </ScrollArea>
          </Box>
        )}
      </AppShell.Header>

      <AppShell.Navbar p="sm" className="drawer">
        <ScrollArea>
          <Stack gap={2}>
            {SECTIONS.map((s) => (
              <Box key={s.label}>
                <UnstyledButton
                  component={NavLink}
                  to={s.to}
                  className="drawer-link"
                  data-section
                  data-active={s === section || undefined}
                >
                  <s.icon size={16} stroke={1.8} />
                  {s.label}
                </UnstyledButton>
                {s === section &&
                  s.items?.map((item) => (
                    <UnstyledButton
                      key={item.to}
                      component={NavLink}
                      to={item.to}
                      className="drawer-link"
                      end
                    >
                      {item.label}
                    </UnstyledButton>
                  ))}
              </Box>
            ))}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main className="app-main">
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
          {/* The tab is in the URL so a report can be linked to and reloaded. */}
          <Route path="/reports" element={<Navigate to="/reports/sales" replace />} />
          <Route path="/reports/:tab" element={<Reports />} />
          <Route path="/catalogs" element={<Navigate to="/catalogs/customers" replace />} />
          <Route path="/catalogs/:tab" element={<Catalogs />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<Text>Page not found.</Text>} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
