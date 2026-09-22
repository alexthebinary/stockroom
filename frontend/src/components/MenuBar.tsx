import { Box, Menu, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconPackage } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export type MenuSection = {
  label: string;
  icon: typeof IconPackage;
  to: string;
  items?: { to: string; label: string }[];
};

/**
 * A macOS-style menu bar, desktop only.
 *
 * Adapted from the Apple HIG menu bar as implemented in PuruVJ/macos-web: a
 * ~28px translucent strip, the app name in bold first, one menu per top-level
 * group, status items right-aligned, and hover-follows-open once any menu is
 * down.
 *
 * ⚠️ DESKTOP ONLY, deliberately. A dropdown is a pointer gesture, and the
 * comment this file's sibling App.tsx opens with rejects hover menus precisely
 * because that gesture does not exist on touch — this app is used on a
 * warehouse floor with gloves. The phone keeps its bottom bar and drawer
 * untouched; this bar is `visibleFrom="sm"`.
 *
 * What it buys: the two stacked rows cost 96px of every desktop screen on an
 * app whose pages are dense tables. This is 28px.
 */
export function MenuBar({
  sections,
  activeSection,
  activePage,
  user,
  onSignOut,
  onActAs,
  ledger,
}: {
  sections: MenuSection[];
  activeSection?: MenuSection;
  activePage?: string;
  user: { email: string; name: string; role: string; actualRole?: string; actualCan?: { users: boolean } };
  onSignOut: () => void;
  onActAs: (role: string | null) => void;
  ledger: { sound: boolean; summary: string } | null;
}) {
  // Which menu is down. macOS lets the pointer slide between titles once one
  // is open, and does nothing on hover when none is.
  const [open, setOpen] = useState<string | null>(null);
  const navigate = useNavigate();


  return (
    <Box component="nav" className="menubar" visibleFrom="sm" aria-label="Main menu">
      {/* The app menu: the wordmark, in bold, exactly where macOS puts it. */}
      <Menu
        opened={open === "__app"}
        onChange={(o) => setOpen(o ? "__app" : null)}
        position="bottom-start"
        offset={2}
        radius={8}
        classNames={{ dropdown: "menubar-dropdown" }}
      >
        <Menu.Target>
          <UnstyledButton
            className="menubar-item menubar-wordmark"
            data-open={open === "__app" || undefined}
            onMouseEnter={() => open && setOpen("__app")}
            aria-haspopup="menu"
          >
            Stockroom
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            {user.name} · {String(user.actualRole ?? user.role).toLowerCase()}
          </Menu.Label>
          <Menu.Item onClick={() => navigate("/about")}>About Stockroom</Menu.Item>
          <Menu.Item onClick={() => navigate("/catalogs/posting")}>Posting rules</Menu.Item>
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
          <Menu.Item onClick={onSignOut}>Sign out</Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {/* Where macOS shows the frontmost app: here, where you actually are. */}
      {activePage && (
        <Text span className="menubar-title" aria-current="page">
          {activePage}
        </Text>
      )}

      {/* Rendered in SECTIONS order. Splitting them by whether they have a
          dropdown reordered the bar and pushed Home to the end. */}
      {sections.map((section) =>
        !section.items?.length ? (
          // A dropdown holding one item is a worse button, so single-page
          // sections stay plain commands.
          <UnstyledButton
            key={section.label}
            component={Link}
            to={section.to}
            className="menubar-item"
            data-active={section === activeSection || undefined}
          >
            {section.label}
          </UnstyledButton>
        ) : (
          <Menu
            key={section.label}
            opened={open === section.label}
            onChange={(o) => setOpen(o ? section.label : null)}
            position="bottom-start"
            offset={2}
            radius={8}
            classNames={{ dropdown: "menubar-dropdown" }}
          >
            <Menu.Target>
              <UnstyledButton
                className="menubar-item"
                data-open={open === section.label || undefined}
                data-active={section === activeSection || undefined}
                // Slide between titles with the pointer, but only once a menu
                // is already down — otherwise crossing the bar opens things.
                onMouseEnter={() => open && setOpen(section.label)}
                aria-haspopup="menu"
              >
                {section.label}
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {section.items!.map((item) => (
                <Menu.Item key={item.to} component={Link} to={item.to}>
                  {item.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )
      )}

      <span style={{ flex: "1 1 auto" }} />

      <div className="menubar-status">
        <LedgerStatus ledger={ledger} />
        <Tooltip label={user.email} withArrow openDelay={400}>
          <UnstyledButton
            className="menubar-item menubar-status-item"
            onClick={() => setOpen("__app")}
          >
            {user.email.split("@")[0]}
          </UnstyledButton>
        </Tooltip>
        <Clock />
      </div>
    </Box>
  );
}

/**
 * The books, as a status item.
 *
 * Shows BOTH states on purpose. The old badge rendered nothing when the ledger
 * was sound and nothing when the check failed, so silence could not be read —
 * an indicator that cannot say "fine" is a decoration.
 */
function LedgerStatus({ ledger }: { ledger: { sound: boolean; summary: string } | null }) {
  if (!ledger) return null;
  return (
    <Tooltip label={ledger.summary} withArrow>
      <UnstyledButton
        component={Link}
        to="/ledger"
        className="menubar-item menubar-status-item"
        data-alarm={!ledger.sound || undefined}
        aria-label={ledger.summary}
      >
        {ledger.sound ? (
          <IconCircleCheck size={13} stroke={2} />
        ) : (
          <IconAlertTriangle size={13} stroke={2} />
        )}
        <span className="menubar-status-label">Books</span>
      </UnstyledButton>
    </Tooltip>
  );
}

/** macOS clock: weekday, date, 24h time. Ticks on the minute, not the second. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Align to the next minute so the display never lags by up to 59 seconds.
    const toNextMinute = (60 - new Date().getSeconds()) * 1000;
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, toNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  return (
    <Text span className="menubar-clock">
      {now.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}
      {"  "}
      {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
    </Text>
  );
}
