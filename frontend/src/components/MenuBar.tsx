import { Box, Menu, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconAlertTriangle, IconCircleCheck, IconPackage, IconUser } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

/**
 * Whether this device actually hovers.
 *
 * Sliding between menu titles is a pointer affordance. On a touch screen the
 * first tap both opens a menu AND fires mouseenter, so hover-follow turns one
 * tap into an open-then-immediately-reopen and feels broken. Width cannot tell
 * you this — a 1024px iPad hovers no better than a phone.
 */
function useHasHover() {
  const [hasHover, setHasHover] = useState(
    () => typeof matchMedia === "function" && matchMedia("(hover: hover)").matches
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(hover: hover)");
    const onChange = () => setHasHover(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return hasHover;
}

/**
 * Whether this device is driven by a finger.
 *
 * Exported because AppShell needs the same answer: it computes the page's top
 * padding from the header height it is GIVEN in JS, not from a CSS variable,
 * so sizing the bar in CSS alone left the first 20px of every page underneath
 * it on touch. One source of truth, read by both.
 */
export const MENUBAR_H_FINE = 28;
export const MENUBAR_H_COARSE = 48;

/**
 * Is the section strip actually scrolled/scrollable?
 *
 * The right-edge fade was applied unconditionally, so "Settings" faded out
 * with a screenful of empty bar beside it — the affordance was lying about
 * overflow that was not happening. CSS cannot ask, so measure.
 */
export function useOverflowing(ref: React.RefObject<HTMLElement | null>) {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflowing(el.scrollWidth - el.clientWidth > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [ref]);
  return overflowing;
}

export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(
    () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

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
  const hasHover = useHasHover();
  const sectionsRef = useRef<HTMLDivElement>(null);
  const sectionsOverflow = useOverflowing(sectionsRef);
  const followPointer = (label: string) => (hasHover && open ? () => setOpen(label) : undefined);


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
            onMouseEnter={followPointer("__app")}
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
      {/* The slot macOS gives the frontmost app. It outranks the wordmark
          when space is short: where you ARE beats what the app is called. */}
      {activePage && (
        <>
          <span className="menubar-divider" aria-hidden />
          <Text span className="menubar-title" aria-current="page">
            {activePage}
          </Text>
          <span className="menubar-divider" aria-hidden />
        </>
      )}

      {/*
        The sections scroll rather than clip. At 768px the bar needed 884px of
        a 758px strip and the clock and account were simply off-screen — and
        the status cluster is the part that must never move, so the sections
        are what gives. Rendered in SECTIONS order; splitting them by whether
        they have a dropdown once reordered the bar and pushed Home to the end.
      */}
      <div
        className="menubar-sections"
        ref={sectionsRef}
        data-overflowing={sectionsOverflow || undefined}
      >
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
                // Slide between titles, but only once a menu is down and only
                // where a pointer exists.
                onMouseEnter={followPointer(section.label)}
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
      </div>

      <span style={{ flex: "1 1 auto" }} />

      <div className="menubar-status">
        <LedgerStatus ledger={ledger} />
        <Tooltip label={user.email} withArrow openDelay={400}>
          <UnstyledButton
            className="menubar-item menubar-status-item"
            onClick={() => setOpen("__app")}
            aria-label={`Signed in as ${user.email}`}
          >
            <IconUser size={13} stroke={2} />
            <span className="menubar-account-label">{user.email.split("@")[0]}</span>
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
