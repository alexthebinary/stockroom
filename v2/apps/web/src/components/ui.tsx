import { formatUsd } from "@pi/domain";
import { Alert, Badge, Button, Center, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { ReactNode } from "react";

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

/** A measured figure, not a card: label above, value below, one rule. */
export function Stat({ label, value, signal, hint }: { label: string; value: ReactNode; signal?: boolean; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-signal={signal ? "true" : undefined}>
        {value}
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
    <Group justify="space-between" align="flex-start" mb="lg" gap="sm">
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
const MEANING: Record<string, { color: string; label: string }> = {
  NOT_BILLED: { color: "gray", label: "Not billed" },
  DRAFT: { color: "orange", label: "Draft" },
  BILLED: { color: "lime", label: "Billed" },
  UNPAID: { color: "gray", label: "Unpaid" },
  PARTIAL: { color: "blue", label: "Part paid" },
  PAID: { color: "lime", label: "Paid" },
  NOT_RECEIVED: { color: "gray", label: "Not received" },
  RECEIVED: { color: "lime", label: "Received" },
  PENDING_BILL: { color: "orange", label: "Awaiting bill" },
  POSTED: { color: "lime", label: "Posted" },
  VOID: { color: "gray", label: "Void" },
  OPEN: { color: "blue", label: "Open" },
  SUBMITTED: { color: "lime", label: "Done" },
  CANCELED: { color: "gray", label: "Cancelled" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const meaning = MEANING[status] ?? { color: "gray", label: status };
  return (
    <Badge color={meaning.color} variant="light" styles={{ label: { textTransform: "none", fontWeight: 600 } }}>
      {label ?? meaning.label}
    </Badge>
  );
}

export function ReceivingBadge({ status, held }: { status: string; held?: number }) {
  if (status === "PARTIAL") return <StatusBadge status="PARTIAL" label={held ? "Part received · awaiting bill" : "Part received"} />;
  if (status === "RECEIVED" && held) return <StatusBadge status="PENDING_BILL" label="Received · awaiting bill" />;
  return <StatusBadge status={status} />;
}

export function Loading() {
  return (
    <Center py="xl">
      <Loader />
    </Center>
  );
}

export function Problem({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="That didn't load">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{error instanceof Error ? error.message : String(error)}</Text>
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
