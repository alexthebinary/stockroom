import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge, Box, Button, Card, Group, Loader, Progress, Select, Stack, Text, TextInput, Title, UnstyledButton,
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

/** Accept a bare array or a paginated `{data: [...]}` envelope. */
function rows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

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
  // Remembered per device: a clerk's phone lives at one dock.
  const [warehouseId, setWarehouseIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem("receive-warehouse");
    } catch {
      return null;
    }
  });
  const setWarehouseId = (v: string | null) => {
    setWarehouseIdState(v);
    try {
      if (v) localStorage.setItem("receive-warehouse", v);
      else localStorage.removeItem("receive-warehouse");
    } catch {
      /* storage blocked */
    }
  };
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [log, setLog] = useState<ScanResult[]>([]);
  const [attempt, setAttempt] = useState(1);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "warn" | "retry"; text: string } | null>(null);

  /**
   * ⚠️ SHAPES DIFFER BETWEEN ENDPOINTS, and assuming one crashed this page.
   * `/warehouses` is PAGINATED and answers `{data: [...], total}`; my own
   * `/receiving/expected` answers a bare array. Written against the assumed
   * array shape, this page threw "(warehouses.data ?? []).map is not a
   * function" and rendered NOTHING after login — and it shipped, because the
   * endpoints were tested with curl and the page was never opened in a browser.
   * `rows()` accepts either, so a future endpoint gaining pagination cannot
   * silently blank the screen again.
   */
  const warehouses = useQuery({
    queryKey: ["warehouses"],
    queryFn: () => api.get<any>("/warehouses"),
  });

  const expected = useQuery({
    queryKey: ["receiving-expected", warehouseId],
    queryFn: () => api.get<any>(`/receiving/expected?warehouseId=${warehouseId}`),
    enabled: Boolean(warehouseId),
    refetchInterval: 30_000,
  });

  // One line still to come is the common case at a small dock: select it
  // instead of asking the clerk to find and tap the only possible answer.
  useEffect(() => {
    const open = rows(expected.data).flatMap((po: any) => po.lines ?? []).filter((l: any) => l.outstanding > 0);
    if (!activeLine && open.length === 1) setActiveLine(open[0].id);
  }, [expected.data, activeLine]);

  const [typed, setTyped] = useState("");

  const scan = useMutation({
    mutationFn: (payload: { image?: string; barcode?: string; typed?: string }) =>
      api.post<ScanResult>("/receiving/scan", {
        purchaseOrderLineId: activeLine,
        image: payload.image,
        barcode: payload.barcode,
        // A serial typed by hand (torn label, gloves) is one reading from one
        // source: the server books it and flags it for a second look, exactly
        // as it treats a single unconfirmed camera read.
        readers: payload.typed ? [{ family: "typed", text: payload.typed, confidence: null }] : [],
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

  const orders = rows(expected.data);

  return (
    <Stack gap="md" className="receive-page">
      <PageHeader title="Receive" subtitle="Scan each box. It books itself." />

      <Select
        size="lg"
        label="Warehouse"
        placeholder="Pick where you are"
        value={warehouseId}
        onChange={setWarehouseId}
        data={rows(warehouses.data).map((w: any) => ({ value: String(w.id), label: `${w.code} — ${w.name}` }))}
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

                {/* Each line is a radio: it must look pickable, be reachable by
                    keyboard and say it is picked — "Pick a line first" pointed
                    at rows that looked like plain text (critique 2026-09-24). */}
                <Stack gap={6} role="radiogroup" aria-label={`Lines on ${po.poNumber ?? "this order"}`}>
                  {po.lines.map((l: any) => {
                    const picked = activeLine === l.id;
                    return (
                      <UnstyledButton
                        key={l.id}
                        role="radio"
                        aria-checked={picked}
                        disabled={l.outstanding === 0}
                        onClick={() => setActiveLine(l.id)}
                        className="receive-line"
                        data-picked={picked || undefined}
                      >
                        <Group justify="space-between" wrap="nowrap" gap="sm">
                          <Group gap="sm" wrap="nowrap">
                            <span className="receive-line-dot" aria-hidden>
                              {picked && <IconCheck size={14} stroke={3} />}
                            </span>
                            <Box>
                              <Text fw={500}>{l.name}</Text>
                              <Text size="xs" c="dimmed">
                                {l.sku}{l.serialized ? " · serial-tracked" : ""}
                              </Text>
                            </Box>
                          </Group>
                          <Badge color={l.outstanding === 0 ? "teal" : "gray"} variant="light" style={{ flex: "none" }}>
                            {l.receivedQty}/{l.quantity}
                          </Badge>
                        </Group>
                      </UnstyledButton>
                    );
                  })}
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

      {/*
        Thumb-reachable, always visible — and ABOVE the phone nav bar, which is
        also fixed to bottom: 0 at a higher stacking order. Positioning was
        inline and the offset has to change at the nav breakpoint, so the rule
        lives in theme.css as .receive-dock.
      */}
      <Box className="receive-dock">
        <Button
          fullWidth size="xl" h={56}
          leftSection={scan.isPending ? <Loader size={20} color="white" /> : <IconCamera size={24} />}
          disabled={!activeLine || scan.isPending}
          onClick={() => { setStatus(null); setCameraOpen(true); }}
        >
          {activeLine ? "Open scanner" : "Tap a line above to start"}
        </Button>
      </Box>

      {activeLine && (
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput
            label="Label torn or unreadable? Type the serial"
            placeholder="e.g. UT1234567"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value.toUpperCase())}
            style={{ flex: 1 }}
            size="md"
          />
          <Button
            size="md"
            variant="light"
            disabled={!typed.trim() || scan.isPending}
            onClick={() => {
              scan.mutate({ typed: typed.trim() });
              setTyped("");
            }}
          >
            Book it
          </Button>
        </Group>
      )}

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
