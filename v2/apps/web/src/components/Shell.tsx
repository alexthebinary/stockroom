import { ActionIcon, AppShell, Avatar, Box, Group, Menu, NavLink, Stack, Text, useMantineColorScheme } from "@mantine/core";
import {
  IconBarcode,
  IconBook2,
  IconBox,
  IconCash,
  IconChartBar,
  IconFileInvoice,
  IconHome,
  IconMessageReport,
  IconMoon,
  IconPrinter,
  IconReceipt2,
  IconRefresh,
  IconSettings,
  IconSun,
  IconSunMoon,
  IconUserCircle,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link, NavLink as RouterNavLink, useLocation } from "react-router-dom";
import type { Job } from "../lib/api";
import { JOB_LABEL, useProfile } from "../lib/profile";
import { resetCoaching } from "./Coach";

type Section = { to: string; label: string; icon: typeof IconHome };

const SECTIONS: Record<string, Section> = {
  home: { to: "/", label: "Home", icon: IconHome },
  receive: { to: "/receive", label: "Receive", icon: IconBarcode },
  orders: { to: "/orders", label: "Orders", icon: IconReceipt2 },
  bills: { to: "/bills", label: "Bills", icon: IconFileInvoice },
  payables: { to: "/payables", label: "Payables", icon: IconCash },
  items: { to: "/items", label: "Items", icon: IconBox },
  reports: { to: "/reports", label: "Reports", icon: IconChartBar },
  settings: { to: "/settings", label: "Settings", icon: IconSettings },
  sheet: { to: "/test-sheet", label: "Test sheet", icon: IconPrinter },
  guide: { to: "/guide", label: "How it works", icon: IconBook2 },
  feedback: { to: "/feedback", label: "Feedback", icon: IconMessageReport },
};

/** The phone's bottom tabs: the three or four things this job does all day. */
const TABS: Record<Job, (keyof typeof SECTIONS)[]> = {
  CLERK: ["home", "receive", "items"],
  ACCOUNTING: ["home", "bills", "payables", "reports"],
  ADMIN: ["home", "orders", "reports", "settings"],
};

/** The desktop rail: everything, grouped, the job's own work first. */
const RAIL: Record<Job, (keyof typeof SECTIONS)[]> = {
  CLERK: ["home", "receive", "items", "orders", "sheet", "guide"],
  ACCOUNTING: ["home", "bills", "payables", "orders", "reports", "items", "receive", "settings", "guide", "feedback"],
  ADMIN: ["home", "orders", "bills", "payables", "receive", "items", "reports", "settings", "sheet", "guide", "feedback"],
};

const isActive = (pathname: string, to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));

export function Shell({ children }: { children: ReactNode }) {
  const { profile, choose } = useProfile();
  const { pathname } = useLocation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const job = profile?.job ?? "CLERK";

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 232, breakpoint: "sm", collapsed: { mobile: true } }} padding="md">
      <AppShell.Header className="no-print">
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Group gap={8} wrap="nowrap">
              <img src="/icon.svg" width={28} height={28} alt="" style={{ borderRadius: 7 }} />
              <Text fw={700} size="lg">
                ProfitIndex
              </Text>
            </Group>
          </Link>
          <Menu position="bottom-end" width={240}>
            <Menu.Target>
              <ActionIcon variant="subtle" size={44} aria-label="Who's working and settings">
                <Avatar size={32} color="ink" radius="xl">
                  {profile?.name.slice(0, 1) ?? <IconUserCircle />}
                </Avatar>
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                {profile?.name} · {JOB_LABEL[job]}
              </Menu.Label>
              <Menu.Item leftSection={<IconUserCircle size={16} />} onClick={() => choose(null)}>
                Switch person
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>Appearance</Menu.Label>
              {(
                [
                  ["auto", "Match this device", IconSunMoon],
                  ["light", "Light", IconSun],
                  ["dark", "Dark", IconMoon],
                ] as const
              ).map(([scheme, label, Icon]) => (
                <Menu.Item key={scheme} leftSection={<Icon size={16} />} onClick={() => setColorScheme(scheme)} fw={colorScheme === scheme ? 600 : undefined}>
                  {label}
                </Menu.Item>
              ))}
              <Menu.Divider />
              <Menu.Item leftSection={<IconRefresh size={16} />} onClick={resetCoaching}>
                Show tips again
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs" className="no-print">
        <Stack gap={2}>
          {RAIL[job].map((key) => {
            const s = SECTIONS[key]!;
            return <NavLink key={key} component={RouterNavLink} to={s.to} label={s.label} leftSection={<s.icon size={18} />} active={isActive(pathname, s.to)} style={{ borderRadius: 8 }} />;
          })}
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box maw={1100} mx="auto" pb={{ base: 96, sm: 32 }}>
          {children}
        </Box>
      </AppShell.Main>

      <Box component="nav" className="tabbar no-print" hiddenFrom="sm" aria-label="Main">
        {TABS[job].map((key) => {
          const s = SECTIONS[key]!;
          return (
            <Link key={key} to={s.to} aria-current={isActive(pathname, s.to) ? "page" : undefined}>
              <s.icon size={24} stroke={1.75} />
              {s.label}
            </Link>
          );
        })}
      </Box>
    </AppShell>
  );
}
