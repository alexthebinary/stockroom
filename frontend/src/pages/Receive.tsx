import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge, Box, Button, Card, Group, Loader, Progress, Select, Stack, Text, Title,
} from "@mantine/core";
import { IconCamera, IconCheck, IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { api } from "../api";
import { LabelScanner } from "../components/LabelScanner";
import { PageHeader, QueryState } from "../components/ui";

/**
 * Receiving, built for a phone at a dock.
 *
 * The screen is a FEED, not a form. Each scan commits on its own and drops a
 * line into the log; nothing waits for a confirmation tap. The only thing that
 * can interrupt is a label no reader could read, and that asks for another
 * photo before it asks for a person.
 *
 * Touch targets are 56px because this is used with gloves on, and the primary
 * action sits at the bottom of the screen where a thumb reaches.
 */

type ScanResult = {
  outcome: "received" | "retry" | "escalate";
  serial: string | null;
  evidence?: string;
  flagged?: boolean;
  flagReason?: string | null;
  message?: string | null;
  line?: { sku: string; receivedQty: number; quantity: number; outstanding: number };
};

export default function Receive() {
  const qc = useQueryClient();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [log, setLog] = useState<ScanResult[]>([]);
  const [attempt, setAttempt] = useState(1);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "warn" | "retry"; text: string } | null>(null);

  const warehouses = useQuery({
    queryKey: ["warehouses"],
    queryFn: () => api.get<any[]>("/warehouses"),
  });

  const expected = useQuery({
    queryKey: ["receiving-expected", warehouseId],
    queryFn: () => api.get<any[]>(`/receiving/expected?warehouseId=${warehouseId}`),
    enabled: Boolean(warehouseId),
    refetchInterval: 30_000,
  });

  const scan = useMutation({
    mutationFn: (payload: { image: string; barcode?: string }) =>
      api.post<ScanResult>("/receiving/scan", {
        purchaseOrderLineId: activeLine,
        image: payload.image,
        barcode: payload.barcode,
        readers: [],
        attempt,
      }),
    onSuccess: (result) => {
      setLog((l) => [result, ...l].slice(0, 30));
      if (result.outcome === "received") {
        setAttempt(1);
        setStatus({
          tone: result.flagged ? "warn" : "ok",
          text: result.flagged
            ? `${result.serial ?? "Received"} — flagged: ${result.flagReason}`
            : `${result.serial ?? "Received"} · ${result.line?.outstanding} left`,
        });
        // The viewfinder stays open; only the numbers behind it change.
        qc.invalidateQueries({ queryKey: ["receiving-expected"] });
      } else {
        setAttempt((a) => a + 1);
        setStatus({ tone: "retry", text: result.message ?? "Try another angle" });
      }
    },
    onError: (e: any) => {
      setStatus({ tone: "warn", text: e?.message ?? "Scan failed — try again" });
    },
  });

  const orders = expected.data ?? [];

  return (
    <Stack gap="md" pb={96}>
      <PageHeader title="Receive" subtitle="Scan each box. It books itself." />

      <Select
        size="lg"
        label="Warehouse"
        placeholder="Pick where you are"
        value={warehouseId}
        onChange={setWarehouseId}
        data={(warehouses.data ?? []).map((w: any) => ({ value: String(w.id), label: `${w.code} — ${w.name}` }))}
        styles={{ input: { height: 56, fontSize: 18 } }}
      />

      {!warehouseId && (
        <Text c="dimmed" size="sm">Choose a warehouse to see what is arriving.</Text>
      )}

      {warehouseId && (
        <QueryState isLoading={expected.isLoading} error={expected.error} onRetry={expected.refetch}>
          <Stack gap="sm">
            {orders.length === 0 && <Text c="dimmed">Nothing expected here right now.</Text>}
            {orders.map((po: any) => (
              <Card key={po.id} withBorder padding="md" radius="md">
                <Group justify="space-between" mb={6}>
                  <Text fw={600}>{po.vendor}</Text>
                  <Badge color="blue" variant="light">{po.poNumber}</Badge>
                </Group>
                <Progress
                  value={(po.received / Math.max(po.ordered, 1)) * 100}
                  color="teal" size="lg" radius="sm" mb={8}
                />
                <Text size="sm" c="dimmed" mb={8}>
                  {po.received} of {po.ordered} received · {po.outstanding} still to come
                </Text>

                <Stack gap={6}>
                  {po.lines.map((l: any) => (
                    <Group
                      key={l.id}
                      justify="space-between"
                      onClick={() => setActiveLine(l.id)}
                      style={{
                        cursor: "pointer", padding: "10px 12px", borderRadius: 8,
                        background: activeLine === l.id ? "rgba(0,128,128,0.10)" : undefined,
                        minHeight: 56,
                      }}
                    >
                      <Box>
                        <Text fw={500}>{l.name}</Text>
                        <Text size="xs" c="dimmed">
                          {l.sku}{l.serialized ? " · serial-tracked" : ""}
                        </Text>
                      </Box>
                      <Badge color={l.outstanding === 0 ? "teal" : "gray"} variant="light">
                        {l.receivedQty}/{l.quantity}
                      </Badge>
                    </Group>
                  ))}
                </Stack>
              </Card>
            ))}
          </Stack>
        </QueryState>
      )}

      {log.length > 0 && (
        <Box>
          <Title order={5} mb={6}>This session</Title>
          <Stack gap={6}>
            {log.map((r, i) => (
              <Group key={i} gap={8} wrap="nowrap">
                {r.outcome === "received" && !r.flagged && <IconCheck size={18} color="teal" />}
                {r.outcome === "received" && r.flagged && <IconAlertTriangle size={18} color="orange" />}
                {r.outcome !== "received" && <IconRefresh size={18} color="gray" />}
                <Text size="sm">
                  {r.outcome === "received"
                    ? `${r.line?.sku} ${r.serial ?? ""} — ${r.line?.outstanding} left`
                    : r.message}
                </Text>
              </Group>
            ))}
          </Stack>
        </Box>
      )}

      {/* Thumb-reachable, always visible. */}
      <Box
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, padding: 12,
          background: "var(--mantine-color-body)", borderTop: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Button
          fullWidth size="xl" h={56}
          leftSection={scan.isPending ? <Loader size={20} color="white" /> : <IconCamera size={24} />}
          disabled={!activeLine || scan.isPending}
          onClick={() => { setStatus(null); setCameraOpen(true); }}
        >
          {activeLine ? "Open scanner" : "Pick a line first"}
        </Button>
      </Box>

      <LabelScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        busy={scan.isPending}
        status={status}
        scannedCount={log.filter((r) => r.outcome === "received").length}
        onCapture={(payload) => scan.mutate(payload)}
      />
    </Stack>
  );
}
