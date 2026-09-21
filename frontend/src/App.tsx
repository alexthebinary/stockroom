import { AppShell, Box, Burger, Group, Menu, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBook2,
  IconChartBar,
  IconLayoutDashboard,
  IconPackage,
  IconReceipt,
  IconStack2,
  IconTruckDelivery,
  IconTruckLoading,
  IconSettings,
} from "@tabler/icons-react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { api, type TrialBalance } from "./api";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import About from "./pages/About";
import Adjustments from "./pages/Adjustments";
import Catalogs from "./pages/Catalogs";
import Dashboard from "./pages/Dashboard";
import Deliveries from "./pages/Deliveries";
import Inventory from "./pages/Inventory";
import Invoices from "./pages/Invoices";
import Ledger from "./pages/Ledger";
import Login from "./pages/Login";
import ProductDetail from "./pages/ProductDetail";
import Products from "./pages/Products";
import Receive from "./pages/Receive";
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
  {
    // Invoices and Deliveries are cross-order views of documents that already
    // existed only INSIDE an order. "Which invoices are unpaid" and "what is in
    // transit" were answerable one order at a time and are now answerable.
    label: "Sales",
    icon: IconReceipt,
    to: "/sales-orders",
    items: [
      { to: "/sales-orders", label: "Orders" },
      { to: "/invoices", label: "Invoices" },
      { to: "/deliveries", label: "Deliveries" },
      { to: "/catalogs/customers", label: "Customers" },
    ],
  },
  {
    label: "Purchases",
    icon: IconTruckDelivery,
    to: "/purchase-orders",
    items: [
      { to: "/purchase-orders", label: "Orders" },
      { to: "/catalogs/vendors", label: "Vendors" },
    ],
  },
  {
    label: "Inventory",
    icon: IconStack2,
    to: "/inventory",
    items: [
      { to: "/receive", label: "Receive" },
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
    // Customers and Vendors deliberately live under Sales and Purchases rather
    // than here: maintaining master data is rare, looking it up mid-task is
    // constant, and the frequent path is the one to optimise for. What is left
    // is genuinely configuration.
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
      component={Link}
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

/**
 * The books being wrong is the one condition worth interrupting for, and until
 * now it was an alert on the ledger page — invisible to anyone working
 * anywhere else. This is deliberately a badge and not a blocking dialog:
 * stopping the whole app for a ledger problem halts work the problem does not
 * touch, which teaches people to click through warnings.
 */
function LedgerHealth() {
  const trial = useQuery({
    queryKey: ["trial-balance", "health"],
    queryFn: () => api.get<TrialBalance>("/trial-balance"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  if (!trial.data || trial.data.sound) return null;

  const counts = [
    trial.data.unbalancedEntries.length && `${trial.data.unbalancedEntries.length} unbalanced`,
    trial.data.withdrawnEntries.length && `${trial.data.withdrawnEntries.length} withdrawn`,
    trial.data.orphanedReversals.length && `${trial.data.orphanedReversals.length} orphaned`,
    trial.data.chartInconsistencies.length && `${trial.data.chartInconsistencies.length} mis-signed`,
  ].filter(Boolean).join(", ");

  return (
    <Tooltip label={`The books do not tie out: ${counts}. Open the ledger.`} withArrow>
      <UnstyledButton component={NavLink} to="/ledger" className="rail-alarm">
        <IconAlertTriangle size={15} stroke={2} />
        <Text span size="xs" fw={600} visibleFrom="sm">
          Books
        </Text>
      </UnstyledButton>
    </Tooltip>
  );
}

/**
 * On a phone, the sections an operator actually reaches for while holding a
 * device stay permanently in thumb reach; the rest keep the drawer.
 *
 * Forcing all six into one pattern is what made this look like a hard choice.
 * Reports, Settings and the master-data pages are desk work — nobody does them
 * one-handed on a warehouse floor — so they do not earn a permanent slot.
 */
const PHONE_SECTIONS = ["Home", "Receive", "Sales", "Inventory"];

/**
 * Receive is a page inside Inventory, not a section. It gets a phone slot
 * anyway because it is the highest-frequency action in the product and it was
 * four interactions from the front door, reachable only by swiping a sub-rail
 * that gave no sign it scrolled.
 *
 * Purchases yields the slot rather than Home: writing a purchase order is desk
 * work that precedes the van, and the person holding a phone on the dock is
 * receiving against one, not writing it.
 */
const PHONE_EXTRA: Section[] = [{ label: "Receive", icon: IconTruckLoading, to: "/receive" }];

function BottomBar({ current, pathname }: { current?: Section; pathname: string }) {
  const onReceive = pathname === "/receive" || pathname.startsWith("/receive/");
  const items = [...SECTIONS, ...PHONE_EXTRA]
    .filter((s) => PHONE_SECTIONS.includes(s.label))
    .sort((a, b) => PHONE_SECTIONS.indexOf(a.label) - PHONE_SECTIONS.indexOf(b.label));

  return (
    <Box component="nav" className="bottom-bar" hiddenFrom="sm" aria-label="Main sections">
      {items.map((s) => {
        // Receive lives inside Inventory, so on /receive both would match and
        // two tabs would light at once. The more specific one wins.
        const active = s.label === "Receive" ? onReceive : !onReceive && s === current;
        return (
          <UnstyledButton
            key={s.label}
            component={Link}
            to={s.to}
            className="bottom-link"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
          >
            <s.icon size={19} stroke={1.7} />
            <span>{s.label}</span>
          </UnstyledButton>
        );
      })}
    </Box>
  );
}

export default function App() {
  const [opened, { toggle, close }] = useDisclosure();
  const { user, logout, actAs } = useAuth();
  const location = useLocation();
  const section = sectionFor(location.pathname);
  const subItems = section?.items;
  // Mantine collapses the navbar with a transform alone, so it stays focusable
  // and in the accessibility tree — on desktop, where it can never be opened,
  // Tab walked 7 to 13 invisible links before reaching the page. `inert` is a
  // real attribute that React 18's DOM typings predate, and Mantine spreads
  // unknown props straight onto the element, so it is applied through a spread.
  const drawerInert = (opened ? {} : { inert: "" }) as Record<string, unknown>;

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

            <LedgerHealth />

            <Menu position="bottom-end" shadow="md" radius="md">
              <Menu.Target>
                <UnstyledButton className="rail-account">
                  <Text span size="xs">
                    {user.email}
                  </Text>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {user.name} · {String(user.actualRole ?? user.role).toLowerCase()}
                </Menu.Label>
                {user.actualCan?.users && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>Work as</Menu.Label>
                    {["ADMIN", "FINANCE", "WAREHOUSE", "VIEWER"].map((r) => (
                      <Menu.Item
                        key={r}
                        onClick={() => actAs(r === user.actualRole ? null : r)}
                        rightSection={user.role === r ? "✓" : undefined}
                      >
                        {r.charAt(0) + r.slice(1).toLowerCase()}
                      </Menu.Item>
                    ))}
                  </>
                )}
                <Menu.Divider />
                <Menu.Item onClick={logout}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Box>

        {subItems && (
          <Box component="nav" className="subrail" h={SUB_H} aria-label={`${section!.label} pages`}>
            <ScrollArea type="auto" h="100%" scrollbarSize={4}>
              <Group h={SUB_H} px="md" gap={2} wrap="nowrap">
                {subItems.map((item) => (
                  <UnstyledButton
                    key={item.to}
                    component={NavLink}
                    to={item.to}
                    className="subrail-link"
                  >
                    {item.label}
                  </UnstyledButton>
                ))}
              </Group>
            </ScrollArea>
          </Box>
        )}
      </AppShell.Header>

      <AppShell.Navbar p="sm" className="drawer" {...drawerInert}>
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
                    >
                      {item.label}
                    </UnstyledButton>
                  ))}
              </Box>
            ))}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main className="app-main has-bottom-bar">
        {user.actingAs && (
          <Box className="acting-banner" role="status">
            <Text span size="sm" fw={600}>
              Working as {user.actingAs.toLowerCase()}
            </Text>
            <Text span size="sm">
              You are {user.name}, an administrator. This view is limited on purpose.
            </Text>
            <UnstyledButton className="acting-stop" onClick={() => actAs(null)}>
              Back to administrator
            </UnstyledButton>
          </Box>
        )}
        <Routes>
          <Route path="/receive" element={<Receive />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/warehouses" element={<Warehouses />} />
          <Route path="/warehouses/:id" element={<WarehouseDetail />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/sales-orders" element={<SalesOrders />} />
          <Route path="/sales-orders/:id" element={<SalesOrderDetail />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/deliveries" element={<Deliveries />} />
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

      <BottomBar current={section} pathname={location.pathname} />
    </AppShell>
  );
}
