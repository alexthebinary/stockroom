import { formatUsd } from "@pi/domain";
import { Alert, Button, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconBan, IconCheck, IconCircleDashed, IconClockHour4 } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";

export const usd = (cents: number | null | undefined) => (cents == null ? "—" : formatUsd(cents));

/** "1 unit", "2 units" — counts read as words, not "unit(s)". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Money({ cents, strong }: { cents: number | null | undefined; strong?: boolean }) {
  return (
    <Text span inherit fw={strong ? 600 : undefined} style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      {usd(cents)}
    </Text>
  );
}

/** A whole number that counts up once when it first appears. Still on reduced motion, and on later changes. */
function CountUp({ to }: { to: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!Number.isInteger(to) || to <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(to); return; }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 450);
      setShown(Math.round(to * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to]);
  return <>{shown}</>;
}

/** A measured figure, not a card: label above, value below, one rule. */
export function Stat({ label, value, signal, hint }: { label: string; value: ReactNode; signal?: boolean; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-signal={signal ? "true" : undefined}>
        {typeof value === "number" ? <CountUp to={value} /> : value}
      </div>
      {hint ? (
        <Text size="sm" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <Group className="page-header" justify="space-between" align="flex-start" gap="sm">
      <Stack gap={4} style={{ minWidth: 0, flex: "1 1 260px" }}>
        <Title order={1}>{title}</Title>
        {subtitle ? (
          <Text c="dimmed" size="sm">
            {subtitle}
          </Text>
        ) : null}
      </Stack>
      {action}
    </Group>
  );
}

/**
 * Status means one of four things, whatever the document: nothing yet
 * (gray), in flight (blue), done (lime), needs a person (orange).
 */
/** The four states a status can mean. Every chip shows an icon and words, never colour alone. */
type Tone = "none" | "progress" | "done" | "attention" | "void";
const TONE_ICON: Record<Tone, typeof IconCheck> = { void: IconBan, none: IconCircleDashed, progress: IconClockHour4, done: IconCheck, attention: IconAlertTriangle };
const MEANING: Record<string, { tone: Tone; label: string }> = {
  NOT_BILLED: { tone: "none", label: "Not billed" },
  DRAFT: { tone: "attention", label: "Draft" },
  BILLED: { tone: "done", label: "Billed" },
  UNPAID: { tone: "none", label: "Unpaid" },
  PARTIAL: { tone: "progress", label: "Part paid" },
  PAID: { tone: "done", label: "Paid" },
  NOT_RECEIVED: { tone: "none", label: "Not received" },
  RECEIVED: { tone: "done", label: "Received" },
  PENDING_BILL: { tone: "attention", label: "Awaiting bill" },
  POSTED: { tone: "done", label: "Posted" },
  VOID: { tone: "void", label: "Void" },
  OPEN: { tone: "progress", label: "Open" },
  SUBMITTED: { tone: "done", label: "Done" },
  CANCELED: { tone: "none", label: "Cancelled" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const meaning = MEANING[status] ?? { tone: "none" as Tone, label: status };
  const Icon = TONE_ICON[meaning.tone];
  return (
    <span className="chip" data-tone={meaning.tone}>
      <Icon size={13} aria-hidden="true" />
      {label ?? meaning.label}
    </span>
  );
}

export function ReceivingBadge({ status, held }: { status: string; held?: number }) {
  if (status === "PARTIAL") return <StatusBadge status="PARTIAL" label={held ? "Part received · awaiting bill" : "Part received"} />;
  if (status === "RECEIVED" && held) return <StatusBadge status="PENDING_BILL" label="Received · awaiting bill" />;
  return <StatusBadge status={status} />;
}

/** Placeholder rows in the shape of a list, so the page keeps its layout while it loads. */
export function Loading() {
  return (
    <div className="skeleton-page" role="status" aria-label="Loading">
      <Skeleton height={20} width="38%" radius="sm" />
      {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={48} radius="sm" opacity={1 - i * 0.14} />)}
    </div>
  );
}

export function Problem({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  // A record that does not exist is not a failed load: say so, and offer the way back.
  if (/not found/i.test(message)) {
    return (
      <Stack gap="xs" align="flex-start" py="xl" role="alert">
        <Title order={2}>We couldn't find that</Title>
        <Text c="dimmed" maw="52ch">It may have been removed, or the link is wrong. {message}.</Text>
        <Button component="a" href="/" variant="default">Back to Home</Button>
      </Stack>
    );
  }
  return (
    <Alert color="orange" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" }, icon: { color: "var(--warn-fg)" } }} icon={<IconAlertTriangle size={18} />} title="That didn't load">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{message}</Text>
        {retry ? (
          <Button size="xs" variant="light" onClick={retry}>
            Try again
          </Button>
        ) : null}
      </Stack>
    </Alert>
  );
}

export const toastOk = (message: string) => notifications.show({ message, color: "lime.4", autoClose: 3000 });
export const toastErr = (error: unknown) => notifications.show({ title: "Not saved", message: error instanceof Error ? error.message : String(error), color: "orange", autoClose: 7000 });

export const formatDate = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

export const toInputDate = (iso: string | Date) => new Date(iso).toISOString().slice(0, 10);
