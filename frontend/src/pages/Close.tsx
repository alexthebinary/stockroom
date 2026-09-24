import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  Card,
  Group,
  Stack,
  Text,
  Badge,
  Button,
  Modal,
  Collapse,
  Progress,
} from "@mantine/core";
import { IconCircleCheck, IconCircleX, IconAlertTriangle } from "@tabler/icons-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { PageHeader, QueryState, money, formatDate, toastOk, toastErr } from "../components/ui";

export type CloseCheck = {
  id: string; title: string; why: string; blocking: boolean; passed: boolean;
  findingCount: number;
  findings: { key: string; title: string; detail?: string; to?: string; amountCents?: number }[];
  fix?: { label: string; to: string };
};
export type CloseReport = {
  period: string;
  periodEnd: string;
  status: "open" | "in_progress" | "closed";
  lockDate: string | null;
  canClose: boolean;
  blockingFailed: number; warningsFailed: number; passed: number; total: number;
  checks: CloseCheck[];
  runAt: string;
};
export type CloseRecord = {
  period: string; periodEnd: string; closedAt: string; actor: string;
  passed: number; total: number;
  warnings: { id: string; title: string; findingCount: number }[];
};

/**
 * Last month is the one you close. Anchored on the 15th: stepping a date on
 * the 31st back one month lands on the 1st of the same month, not the last.
 */
function getDefaultPeriod(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getPeriodOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const p = `${y}-${m}`;
    opts.push({ value: p, label: formatPeriod(p) });
  }
  return opts;
}

/** Month end as a calendar date; read in UTC, where the server defines it. */
function endDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "long" });
}

function formatPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString(undefined, { month: "long", year: "numeric" });
}

/** Revenue, cost, stock and cash at month end — what the close certifies. */
function CloseFigures({ periodEnd }: { periodEnd?: string }) {
  const asOf = periodEnd?.slice(0, 10);
  const tb = useQuery({
    queryKey: ["trial-balance", asOf],
    queryFn: () =>
      api.get<{ accounts: { code: string; balanceCents: number }[] }>(`/trial-balance?asOf=${asOf}`),
    enabled: Boolean(asOf),
  });
  const bal = (code: string) => tb.data?.accounts.find((a) => a.code === code)?.balanceCents ?? 0;
  const rows: [string, number][] = [
    ["Sales revenue (to date)", bal("4000")],
    ["Cost of goods sold (to date)", bal("5000")],
    ["Stock value (Inventory)", bal("1200")],
    ["Cash (Bank)", bal("1000")],
  ];
  if (!asOf) return null;
  return (
    <Card withBorder radius="md" p="sm">
      <Stack gap={4}>
        {rows.map(([label, cents]) => (
          <Group key={label} justify="space-between">
            <Text size="sm" c="dimmed">
              {label}
            </Text>
            <Text size="sm" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
              {tb.isLoading ? "…" : money(cents)}
            </Text>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

export default function Close() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(getDefaultPeriod);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The figures being certified, as of the month's last day, shown in the
  // confirmation: closing a month without seeing its numbers is signing blind.
  const { data: report, isLoading: rLoading, error: rError, refetch } = useQuery({
    queryKey: ["close", period],
    queryFn: () => api.get<CloseReport>(`/close/${period}`),
  });

  const { data: histData, isLoading: hLoading, error: hError } = useQuery({
    queryKey: ["close-history"],
    queryFn: () => api.get<{ records: CloseRecord[] }>("/close-history"),
  });
  const history = histData?.records ?? [];

  const isLoading = rLoading || hLoading;
  const error = rError || hError;
  const closedRecord = report?.status === "closed" ? history.find(r => r.period === period) : undefined;

  const closeMut = useMutation({
    mutationFn: () => api.post<{ record: CloseRecord; report: CloseReport }>(`/close/${period}`),
    onSuccess: () => {
      toastOk(`${formatPeriod(period)} closed`);
      // The lock changes what the ledger will accept, so everything refetches.
      queryClient.invalidateQueries();
      setConfirmOpen(false);
    },
    onError: (e) => toastErr(e),
  });

  const toggle = (id: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const statusLine = report ? (() => {
    const name = formatPeriod(report.period);
    if (report.status === "closed" && closedRecord) {
      return `${name} — Closed on ${formatDate(closedRecord.closedAt)} by ${closedRecord.actor}`;
    }
    if (report.status === "in_progress") return `${name} — Month still in progress`;
    if (report.blockingFailed > 0) return `${name} — ${report.blockingFailed} checks blocking`;
    return `${name} — Ready to close`;
  })() : "";

  return (
    <>
      <PageHeader
        title="Month-end close"
        subtitle="Prove the month's stock and books are right, then lock them."
        action={
          <Select
            aria-label="Month"
            value={period}
            onChange={(v) => v && setPeriod(v)}
            data={getPeriodOptions()}
            allowDeselect={false}
            w={200}
          />
        }
      />
      <Stack gap="md">

        <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
          {report && (
            <Stack gap="lg">
              <Card withBorder radius="md" p="lg">
                <Group justify="space-between" align="center" wrap="wrap">
                  <Stack gap={4}>
                    <Text size="xl" fw={650}>{statusLine}</Text>
                    <Text size="sm" c="dimmed">
                      {report.passed} of {report.total} checks pass
                      {report.warningsFailed > 0 && ` · ${report.warningsFailed} to carry forward`}
                      {" · "}checked {formatDate(report.runAt)}
                    </Text>
                  </Stack>
                  <Badge
                    size="xl"
                    variant="light"
                    color={
                      report.status === "closed"
                        ? "teal"
                        : report.blockingFailed > 0
                          ? "red"
                          : report.status === "in_progress"
                            ? "gray"
                            : "blue"
                    }
                  >
                    {report.status === "closed"
                      ? "Closed"
                      : report.blockingFailed > 0
                        ? "Blocked"
                        : report.status === "in_progress"
                          ? "In progress"
                          : "Ready"}
                  </Badge>
                </Group>
                <Progress
                  mt="md"
                  value={(report.passed / Math.max(report.total, 1)) * 100}
                  color={report.blockingFailed > 0 ? "red" : "teal"}
                  aria-label="Checks passing"
                />
              </Card>

              <Card withBorder radius="md" className={report.status === "closed" ? "close-print" : undefined}>
                <Stack gap="sm">
                  {report.checks.map((check) => {
                    const isOpen = expanded.has(check.id);
                    const failed = !check.passed;
                    const icon = check.passed
                      ? <IconCircleCheck color="teal" size={18} />
                      : check.blocking
                        ? <IconCircleX color="red" size={18} />
                        : <IconAlertTriangle color="orange" size={18} />;

                    return (
                      <Stack key={check.id} gap={4}>
                        <Group
                          onClick={() => failed && check.findings.length > 0 && toggle(check.id)}
                          style={{ cursor: failed && check.findings.length > 0 ? "pointer" : "default" }}
                        >
                          {icon}
                          <Stack gap={2} style={{ flex: 1 }}>
                            <Group gap="xs">
                              <Text>{check.title}</Text>
                              {/* Red only when it is actually stopping the close. */}
                              {check.blocking && (
                                <Badge variant="light" color={check.passed ? "gray" : "red"} size="md">
                                  {check.passed ? "required" : "blocks close"}
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed">{check.why}</Text>
                          </Stack>
                          {failed && (
                            <Text size="xs" c="dimmed">
                              {check.findingCount} {check.findingCount === 1 ? "item" : "items"}
                            </Text>
                          )}
                          {failed && check.fix && (
                            <Button component={Link} to={check.fix.to} size="compact-sm" variant="light">
                              {check.fix.label}
                            </Button>
                          )}
                        </Group>

                        <Collapse in={isOpen}>
                          <Stack pl="xl" gap="xs" mt="xs">
                            {check.findings.map((f) => (
                              <Group key={f.key} gap="xs">
                                {f.to ? (
                                  <Link to={f.to} style={{ textDecoration: "none" }}>
                                    <Text size="sm">{f.title}</Text>
                                  </Link>
                                ) : (
                                  <Text size="sm">{f.title}</Text>
                                )}
                                {f.detail && <Text size="xs" c="dimmed">{f.detail}</Text>}
                                {f.amountCents != null && <Text size="sm">{money(f.amountCents)}</Text>}
                              </Group>
                            ))}
                            {check.findingCount > check.findings.length && (
                              <Text size="xs" c="dimmed">
                                and {check.findingCount - check.findings.length} more
                              </Text>
                            )}
                          </Stack>
                        </Collapse>
                      </Stack>
                    );
                  })}
                </Stack>
              </Card>

              {user?.can?.money && report.status !== "closed" && (
                <Group>
                  <Button
                    size="lg"
                    disabled={!report.canClose}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Close {formatPeriod(report.period)}
                  </Button>
                  {!report.canClose && (
                    <Text size="sm" c="dimmed">
                      {report.status === "in_progress"
                        ? `Can be closed after ${endDay(report.periodEnd)}.`
                        : "Fix the blocking checks above to close."}
                    </Text>
                  )}
                </Group>
              )}

              {report.status === "closed" && closedRecord && (
                <Stack gap="xs">
                  <Text size="sm" c="dimmed">
                    Closed on {formatDate(closedRecord.closedAt)} by {closedRecord.actor}
                  </Text>
                  {closedRecord.warnings.length === 0 ? (
                    <Text size="sm" c="dimmed">Nothing carried forward.</Text>
                  ) : (
                    closedRecord.warnings.map((w) => (
                      <Text key={w.id} size="sm">
                        Carried forward: {w.title} ({w.findingCount})
                      </Text>
                    ))
                  )}
                  <Button variant="light" onClick={() => window.print()}>
                    Print close report
                  </Button>
                </Stack>
              )}
            </Stack>
          )}
        </QueryState>

        <Stack gap="xs" mt="xl">
          <Text fw={500} size="sm">Closed months</Text>
          {history.length === 0 && <Text size="sm" c="dimmed">None yet</Text>}
          {history.map((rec) => (
            <Group key={rec.period} gap="md">
              <Text size="sm">{formatPeriod(rec.period)}</Text>
              <Text size="xs" c="dimmed">{formatDate(rec.closedAt)} by {rec.actor}</Text>
              <Text size="xs" c="dimmed">{rec.warnings.length} warnings carried forward</Text>
            </Group>
          ))}
        </Stack>
      </Stack>

      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)} title="Close books">
        <Stack>
          <Text size="sm">
            Locks the books through {report && endDay(report.periodEnd)}. Nothing dated on or before it can be posted,
            changed or deleted afterwards; corrections post in the next open month.
          </Text>
          <CloseFigures periodEnd={report?.periodEnd} />
          <Text size="sm" c="dimmed">
            {(report?.warningsFailed ?? 0) === 0
              ? "Nothing to carry forward."
              : `${report?.warningsFailed} ${report?.warningsFailed === 1 ? "item" : "items"} will be carried forward and listed in the close report.`}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={() => closeMut.mutate()} loading={closeMut.isPending}>
              Close {formatPeriod(period)}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
