import { Alert, Badge, Button, Card, Center, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ReactNode } from "react";
import { ApiError } from "../api";

/**
 * Four meanings, not seven hues.
 *
 * Statuses and movement types across the app reduce to: nothing has happened
 * yet, something is in flight, stock came in, stock went out — plus stopped.
 * Rendered as shade 9 text on shade 0, the combination that clears 4.5:1 on
 * white for every hue used: gray 14.63, blue 5.48, teal 4.67, grape 6.54,
 * red 5.10.
 */
const NEUTRAL = "gray";
const IN_FLIGHT = "blue";
const INBOUND = "teal";
const OUTBOUND = "grape";
const STOPPED = "red";

const STATUS_HUES: Record<string, string> = {
  // Nothing has happened yet
  DRAFT: NEUTRAL,
  SAVED: NEUTRAL,
  PENDING: NEUTRAL,
  NOT_PACKED: NEUTRAL,
  AWAITING_PAYMENT: NEUTRAL,

  // In flight — committed, not yet settled
  PACKED: IN_FLIGHT,
  CONFIRMED: IN_FLIGHT,
  RESERVED: IN_FLIGHT,
  ORDERED: IN_FLIGHT,
  POSTED: IN_FLIGHT,
  INVOICED: IN_FLIGHT,
  IN_TRANSIT: IN_FLIGHT,

  // Settled / stock arrived
  SHIPPED: INBOUND,
  RECEIVED: INBOUND,
  DELIVERED: INBOUND,
  COMPLETED: INBOUND,
  PAID: INBOUND,
  PURCHASE_RECEIPT: INBOUND,
  TRANSFER_IN: INBOUND,
  ADJUSTMENT_IN: INBOUND,
  INCREASE: INBOUND,

  // Stock left
  SALE_SHIP: OUTBOUND,
  TRANSFER_OUT: OUTBOUND,
  ADJUSTMENT_OUT: OUTBOUND,
  DECREASE: OUTBOUND,

  // Stopped
  CANCELED: STOPPED,
  VOID: STOPPED,
  VOIDED: STOPPED,
};

/** `IN_TRANSIT` is a database value; "In transit" is what a person reads. */
export function formatStatus(value: string) {
  const words = value.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Money is stored in integer cents everywhere; this is the only formatter. */
export function money(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

/**
 * A status filling its whole table cell, the way an operations board reads,
 * rather than a pill floating in whitespace.
 */
export function StatusCell({ value }: { value: string }) {
  const hue = STATUS_HUES[value] ?? NEUTRAL;
  return (
    <span
      className="status-cell"
      style={{
        background: `var(--mantine-color-${hue}-0)`,
        color: `var(--mantine-color-${hue}-9)`,
        boxShadow: `inset 2px 0 0 var(--mantine-color-${hue}-6)`,
      }}
    >
      {formatStatus(value)}
    </span>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const hue = STATUS_HUES[value] ?? NEUTRAL;
  return (
    <Badge
      size="lg"
      radius="sm"
      variant="default"
      styles={{
        root: {
          backgroundColor: `var(--mantine-color-${hue}-0)`,
          color: `var(--mantine-color-${hue}-9)`,
          border: `1px solid var(--mantine-color-${hue}-2)`,
          textTransform: "none",
          fontWeight: 600,
        },
      }}
    >
      {formatStatus(value)}
    </Badge>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" mb="md" wrap="wrap">
      <Stack gap={2}>
        <Title order={2}>{title}</Title>
        {subtitle && (
          <Text c="dimmed" size="sm">
            {subtitle}
          </Text>
        )}
      </Stack>
      {action}
    </Group>
  );
}

/** One stat card, used by the dashboard and every detail page. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Title order={3} mt={4}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </Title>
      ) : (
        <Group mt={8}>{value}</Group>
      )}
      {hint && (
        <Text size="xs" c="dimmed" mt={2}>
          {hint}
        </Text>
      )}
    </Card>
  );
}

/**
 * Single place that renders loading / error / empty so every page behaves
 * alike. The error branch offers a retry, because react-query has already
 * given up by the time it renders.
 */
export function QueryState({
  isLoading,
  error,
  isEmpty,
  emptyMessage = "Nothing here yet.",
  emptyAction,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (error) {
    return (
      <Alert color="red" title="Could not load data">
        <Text size="sm">{errorMessage(error)}</Text>
        {onRetry && (
          <Button variant="light" color="red" size="xs" mt="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Alert>
    );
  }
  if (isEmpty) {
    return (
      <Stack align="center" py="lg" gap="sm">
        <Text c="dimmed">{emptyMessage}</Text>
        {emptyAction}
      </Stack>
    );
  }
  return <>{children}</>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/** The sentence is the message; "Done" as a title carries nothing. */
export const toastOk = (message: string) =>
  notifications.show({ color: "teal", title: message, message: "" });

export const toastErr = (error: unknown) =>
  notifications.show({ color: "red", title: "That did not work", message: errorMessage(error) });

export function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Renders the from/to pair of a movement in one cell. */
export function MovementRoute({
  from,
  to,
}: {
  from?: { code: string } | null;
  to?: { code: string } | null;
}) {
  if (from && to) return <Text size="sm">{`${from.code} to ${to.code}`}</Text>;
  if (from) return <Text size="sm">{`out of ${from.code}`}</Text>;
  if (to) return <Text size="sm">{`into ${to.code}`}</Text>;
  return <Text size="sm" c="dimmed">—</Text>;
}
