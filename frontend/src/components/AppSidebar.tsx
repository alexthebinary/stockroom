import {
  Badge,
  Box,
  Menu,
  NavLink as MantineNavLink,
  ScrollArea,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconCircleCheck,
  IconDeviceDesktop,
  IconMoon,
  IconPackage,
  IconSearch,
  IconSun,
} from "@tabler/icons-react";
import { Link, useLocation } from "react-router-dom";
import type { Attention } from "../api";

export type SidebarItem = {
  to: string;
  label: string;
  /** What this row should SAY is waiting, not merely where it goes. */
  attention?: (a: Attention) => { count: number; tone: "urgent" | "notice" } | null;
};

export type SidebarSection = {
  label: string;
  icon: typeof IconPackage;
  to: string;
  items?: SidebarItem[];
  attention?: (a: Attention) => { count: number; tone: "urgent" | "notice" } | null;
  /** Server capability this needs. Absent means everyone sees it. */
  needs?: "stock" | "money" | "users";
};

export type SidebarGroup = { label: string; sections: SidebarSection[] };

/**
 * The navigation.
 *
 * Built as a list rather than a bar for three reasons the reviews kept
 * returning to: 22 destinations is too many for a horizontal strip, a dropdown
 * hides structure that a list shows at rest, and a vertical list is trivial to
 * filter by role — which is what finally closes the gap between what the
 * server enforces and what the UI offers.
 *
 * Rows carry COUNTS. A navigation that only says where things are makes the
 * operator open each page to find the work; one that says "Invoices · 3 unpaid"
 * has already answered the question they came with.
 */
export function AppSidebar({
  groups,
  attention,
  collapsed,
  onToggle,
  onSearch,
  can,
  ledger,
  user,
  onSignOut,
  onActAs,
}: {
  groups: SidebarGroup[];
  attention?: Attention;
  collapsed: boolean;
  onToggle: () => void;
  onSearch: () => void;
  can: { stock: boolean; money: boolean; users: boolean };
  ledger: { sound: boolean; summary: string } | null;
  user: { email: string; name: string; role: string; actualRole?: string; actualCan?: { users: boolean } };
  onSignOut: () => void;
  onActAs: (role: string | null) => void;
}) {
  const location = useLocation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  const isActive = (to: string) =>
    to === "/" ? location.pathname === "/" : location.pathname === to || location.pathname.startsWith(`${to}/`);

  const badgeFor = (fn?: SidebarSection["attention"]) => {
    if (!fn || !attention) return null;
    const result = fn(attention);
    if (!result || result.count <= 0) return null;
    return (
      <Badge
        size="sm"
        variant="light"
        color={result.tone === "urgent" ? "orange" : "gray"}
        className="sidebar-count"
      >
        {result.count}
      </Badge>
    );
  };

  return (
    <div className="sidebar" data-collapsed={collapsed || undefined}>
      <div className="sidebar-head">
        {!collapsed && (
          <Text span className="sidebar-wordmark">
            Stockroom
          </Text>
        )}
        <Tooltip label={collapsed ? "Expand (⌘B)" : "Collapse (⌘B)"} position="right" withArrow>
          <UnstyledButton
            className="sidebar-collapse"
            onClick={onToggle}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <IconChevronLeft size={15} stroke={2} />
          </UnstyledButton>
        </Tooltip>
      </div>

      {/* Top slot, where a tool people live in puts search. */}
      <Tooltip label="Search  ⌘K" position="right" withArrow disabled={!collapsed}>
        <UnstyledButton className="sidebar-search" onClick={onSearch} aria-label="Search">
          <IconSearch size={15} stroke={1.9} />
          {!collapsed && (
            <>
              <span className="sidebar-search-label">Search</span>
              <kbd className="sidebar-kbd">⌘K</kbd>
            </>
          )}
        </UnstyledButton>
      </Tooltip>

      <ScrollArea className="sidebar-scroll" type="hover" scrollbarSize={6}>
        {groups.map((group) => {
          // Hide a whole group when the role can reach nothing in it, rather
          // than leaving an empty heading behind.
          const visible = group.sections.filter((s) => !s.needs || can[s.needs]);
          if (!visible.length) return null;

          return (
            <div key={group.label} className="sidebar-group">
              {!collapsed && <Text className="sidebar-group-label">{group.label}</Text>}
              {visible.map((section) => {
                const active = isActive(section.to) || section.items?.some((i) => isActive(i.to));
                // Collapsed, there is no room for a number — but hiding the
                // signal entirely defeats the point of carrying it. A dot says
                // "something is waiting here" and the tooltip says what.
                const pending =
                  attention &&
                  (section.attention?.(attention) ??
                    section.items?.reduce<{ count: number; tone: string } | null>(
                      (found, i) => found ?? i.attention?.(attention) ?? null,
                      null
                    ));
                const row = (
                  <MantineNavLink
                    key={section.label}
                    component={Link}
                    to={section.to}
                    label={collapsed ? undefined : section.label}
                    leftSection={
                      <span className="sidebar-icon" data-pending={collapsed && pending ? (pending as { tone: string }).tone : undefined}>
                        <section.icon size={17} stroke={1.7} />
                      </span>
                    }
                    rightSection={collapsed ? undefined : badgeFor(section.attention)}
                    active={active}
                    className="sidebar-link"
                    // Expanded when you are inside it, so the structure is
                    // visible at rest instead of behind a click.
                    defaultOpened={active}
                    childrenOffset={collapsed ? 0 : 30}
                    aria-current={isActive(section.to) ? "page" : undefined}
                  >
                    {!collapsed &&
                      section.items?.map((item) => (
                        <MantineNavLink
                          key={item.to}
                          component={Link}
                          to={item.to}
                          label={item.label}
                          rightSection={badgeFor(item.attention)}
                          active={isActive(item.to)}
                          className="sidebar-sublink"
                          aria-current={isActive(item.to) ? "page" : undefined}
                        />
                      ))}
                  </MantineNavLink>
                );

                return collapsed ? (
                  <Tooltip
                    key={section.label}
                    label={
                      pending
                        ? `${section.label} — ${(pending as { count: number }).count} waiting`
                        : section.label
                    }
                    position="right"
                    withArrow
                  >
                    <div>{row}</div>
                  </Tooltip>
                ) : (
                  row
                );
              })}
            </div>
          );
        })}
      </ScrollArea>

      <div className="sidebar-foot">
        {ledger && (
          <Tooltip label={ledger.summary} position="right" withArrow multiline w={240}>
            <UnstyledButton
              component={Link}
              to="/ledger"
              className="sidebar-status"
              data-alarm={!ledger.sound || undefined}
            >
              {ledger.sound ? (
                <IconCircleCheck size={15} stroke={1.9} />
              ) : (
                <IconAlertTriangle size={15} stroke={1.9} />
              )}
              {!collapsed && <span>{ledger.sound ? "Books tie out" : "Books do not tie out"}</span>}
            </UnstyledButton>
          </Tooltip>
        )}

        <Menu position="right-end" withArrow shadow="md" radius="md">
          <Menu.Target>
            <UnstyledButton className="sidebar-account" aria-label={`Signed in as ${user.email}`}>
              <span className="sidebar-avatar">{user.email.charAt(0).toUpperCase()}</span>
              {!collapsed && (
                <span className="sidebar-account-text">
                  <span className="sidebar-account-name">{user.email.split("@")[0]}</span>
                  <span className="sidebar-account-role">
                    {String(user.actualRole ?? user.role).toLowerCase()}
                  </span>
                </span>
              )}
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{user.email}</Menu.Label>
            {user.actualCan?.users && (
              <>
                <Menu.Divider />
                <Menu.Label>Work as</Menu.Label>
                {["ADMIN", "FINANCE", "WAREHOUSE", "VIEWER"].map((r) => (
                  <Menu.Item
                    key={r}
                    onClick={() => onActAs(r === user.actualRole ? null : r)}
                    rightSection={user.role === r ? "✓" : undefined}
                  >
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </Menu.Item>
                ))}
              </>
            )}
            <Menu.Divider />
            <Menu.Label>Appearance</Menu.Label>
            {(
              [
                ["auto", "System", IconDeviceDesktop],
                ["light", "Light", IconSun],
                ["dark", "Dark", IconMoon],
              ] as const
            ).map(([value, label, Icon]) => (
              <Menu.Item
                key={value}
                leftSection={<Icon size={15} stroke={1.6} />}
                onClick={() => setColorScheme(value)}
                // `colorScheme` is the CHOICE ("auto"), not the resolved
                // scheme — which is what the tick should follow, or picking
                // System on a dark machine would tick Dark.
                rightSection={colorScheme === value ? "✓" : undefined}
              >
                {label}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item onClick={onSignOut}>Sign out</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}

export { Box };
