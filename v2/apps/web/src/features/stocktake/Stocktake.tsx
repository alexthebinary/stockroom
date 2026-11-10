import { barcodeKey } from "@pi/domain";
import { ActionIcon, Alert, Button, Group, Loader, NumberInput, Progress, Select, Stack, Text, TextInput, Title, UnstyledButton } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBarcode, IconCheck, IconMinus, IconPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { TactileButton } from "../../components/kitchen/TactileButton";
import { Ruled } from "../../components/Ruled";
import { Problem, toastErr } from "../../components/ui";
import { get, post } from "../../lib/api";
import type { Item, Warehouse } from "../../lib/types";
import { type ScanFeedback, Scanner } from "../scan/Scanner";

type CountLine = { itemId: number; sku: string; name: string; expected: number; counted: number; ready: boolean };
type ItemStock = { balances: { warehouseId: number; onHand: number }[] };
type Posted = { docNumber: string };

const lastWarehouse = () => {
  try {
    return Number(localStorage.getItem("pi.warehouse")) || null;
  } catch {
    return null;
  }
};

const stocktakeReason = (now = new Date()) => {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `Stock count ${now.getFullYear()}-${month}-${day}`;
};

/** Serial-tracked units and bundles have no countable on-hand quantity here. */
function blockReason(item: Item): string | null {
  if (item.trackingMode === "SERIAL") return "Serial-tracked; count each unit from its serial record";
  if (item.isBundle) return "A bundle has no stock of its own; count its components";
  return null;
}

function difference(line: CountLine): { text: string; color: string } | null {
  if (!line.ready) return null;
  const delta = line.counted - line.expected;
  if (delta < 0) return { text: `short ${-delta}`, color: "var(--warn-fg)" };
  if (delta > 0) return { text: `over ${delta}`, color: "var(--mantine-color-blue-7)" };
  return { text: "ok", color: "var(--ok-fg)" };
}

/**
 * Phone count: pick the warehouse, count what is in front of you, then post
 * every difference as one ADJ document. Items left off the list stay as they are.
 */
export function Stocktake() {
  const queryClient = useQueryClient();
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [warehouseId, setWarehouseId] = useState<number | null>(lastWarehouse());
  const [lines, setLines] = useState<CountLine[]>([]);
  const [posted, setPosted] = useState<string | null>(null);
  const onlyWarehouse = warehouses.data?.length === 1 ? warehouses.data[0]!.id : null;

  useEffect(() => {
    if (onlyWarehouse == null || posted) return;
    if (warehouseId !== onlyWarehouse) setWarehouseId(onlyWarehouse);
    if (step === 1) setStep(2);
  }, [onlyWarehouse, warehouseId, step, posted]);

  const pickWarehouse = (id: number) => {
    if (id !== warehouseId) setLines([]);
    setWarehouseId(id);
    try {
      localStorage.setItem("pi.warehouse", String(id));
    } catch {
      // The choice still applies to this count.
    }
    setStep(2);
  };

  const visibleSteps = onlyWarehouse == null ? 3 : 2;
  const visibleStep = posted ? visibleSteps : onlyWarehouse == null ? step : step - 1;
  const warehouse = warehouses.data?.find((w) => w.id === warehouseId) ?? null;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={1}>Stock count</Title>
          <Text c="dimmed" size="sm">Count what is on the shelf and correct any difference.</Text>
        </div>
        <Text c="dimmed" size="sm">
          Step {visibleStep} of {visibleSteps}
        </Text>
      </Group>
      <Progress aria-label={`Step ${visibleStep} of ${visibleSteps}`} value={(visibleStep / visibleSteps) * 100} color="lime.4" size="sm" />
      {warehouses.error ? <Problem error={warehouses.error} retry={() => warehouses.refetch()} /> : null}
      {!warehouses.data && !warehouses.error ? <Loader /> : null}

      {posted && warehouseId ? (
        <PostedStep docNumber={posted} onAnother={() => { setPosted(null); setLines([]); setStep(onlyWarehouse == null ? 1 : 2); void queryClient.invalidateQueries(); }} />
      ) : null}

      {!posted && step === 1 && warehouses.data && onlyWarehouse == null ? (
        <WhereStep warehouses={warehouses.data} value={warehouseId} onPick={pickWarehouse} />
      ) : null}

      {!posted && step >= 2 && warehouseId && warehouse ? (
        <CountStep
          key={warehouse.id}
          warehouse={warehouse}
          step={step === 3 ? 3 : 2}
          lines={lines}
          setLines={setLines}
          onStep={setStep}
          onBack={onlyWarehouse == null ? () => setStep(1) : undefined}
          onPosted={(docNumber) => {
            setPosted(docNumber);
            void queryClient.invalidateQueries();
          }}
        />
      ) : null}
    </Stack>
  );
}

function WhereStep({ warehouses, value, onPick }: { warehouses: Warehouse[]; value: number | null; onPick: (id: number) => void }) {
  return (
    <Stack>
      <Title order={2} size="lg" fw={500}>
        Which warehouse are you counting?
      </Title>
      <Ruled label="Warehouses">
        {warehouses.map((w) => (
          <UnstyledButton key={w.id} className="ruled-row" onClick={() => onPick(w.id)} style={{ width: "100%", textAlign: "left" }}>
            <div>
              <div className="ruled-row-title">
                {w.name}
                {w.id === value ? <Text span inherit c="dimmed"> · Last used</Text> : null}
              </div>
              <div className="ruled-row-meta">{w.code}</div>
            </div>
          </UnstyledButton>
        ))}
      </Ruled>
      {warehouses.length === 0 ? <Alert color="orange">No warehouses yet. An admin adds them under Settings.</Alert> : null}
    </Stack>
  );
}

function CountStep({
  warehouse,
  step,
  lines,
  setLines,
  onStep,
  onBack,
  onPosted,
}: {
  warehouse: Warehouse;
  step: 2 | 3;
  lines: CountLine[];
  setLines: Dispatch<SetStateAction<CountLine[]>>;
  onStep: (step: 2 | 3) => void;
  onBack?: () => void;
  onPosted: (docNumber: string) => void;
}) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const expectedCache = useRef(new Map<number, number>());
  const loading = useRef(new Set<number>());
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState(stocktakeReason);
  const [finishing, setFinishing] = useState(false);
  const [pick, setPick] = useState<string | null>(null);

  const byKey = useMemo(() => {
    const map = new Map<string, Item>();
    for (const item of items.data ?? []) {
      for (const barcode of item.barcodes ?? []) map.set(barcode.code, item);
      map.set(item.sku.toUpperCase(), item);
    }
    return map;
  }, [items.data]);

  const addCount = async (item: Item, by = 1): Promise<boolean> => {
    const known = expectedCache.current.get(item.id);
    setLines((prev) => {
      const hit = prev.find((line) => line.itemId === item.id);
      if (hit) return prev.map((line) => (line.itemId === item.id ? { ...line, counted: line.counted + by } : line));
      return [...prev, { itemId: item.id, sku: item.sku, name: item.name, expected: known ?? 0, counted: by, ready: known != null }];
    });
    setNote(null);
    if (known != null || loading.current.has(item.id)) return true;
    loading.current.add(item.id);
    try {
      // Valuation is the company total. This count is one warehouse, so expected is that warehouse's on hand.
      const detail = await get<ItemStock>(`/items/${item.id}`);
      const expected = detail.balances.find((balance) => balance.warehouseId === warehouse.id)?.onHand ?? 0;
      expectedCache.current.set(item.id, expected);
      setLines((prev) => prev.map((line) => (line.itemId === item.id ? { ...line, expected, ready: true } : line)));
      return true;
    } catch (error) {
      toastErr(error);
      setLines((prev) => prev.filter((line) => line.itemId !== item.id));
      return false;
    } finally {
      loading.current.delete(item.id);
    }
  };

  const onScan = async (raw: string): Promise<ScanFeedback> => {
    if (!items.data) {
      setNote("The item list is still loading. Scan again in a moment.");
      return "warn";
    }
    const item = byKey.get(barcodeKey(raw)) ?? null;
    if (!item) {
      setNote(`No item has the barcode ${raw.trim()}.`);
      return "warn";
    }
    const why = blockReason(item);
    if (why) {
      setNote(`${item.name}: ${why}`);
      return "warn";
    }
    return (await addCount(item)) ? "ok" : "error";
  };

  const setCounted = (itemId: number, value: number | string) => {
    const counted = value === "" || !Number.isFinite(Number(value)) ? 0 : Math.max(0, Math.floor(Number(value)));
    setLines((prev) => prev.map((line) => (line.itemId === itemId ? { ...line, counted } : line)));
  };

  const chooseItem = (id: string | null) => {
    setPick(null);
    const item = items.data?.find((row) => String(row.id) === id);
    if (!item || blockReason(item)) return;
    void addCount(item);
  };

  const pending = lines.some((line) => !line.ready);
  const diffs = lines.filter((line) => line.ready && line.counted !== line.expected);
  const countedUnits = lines.reduce((sum, line) => sum + line.counted, 0);

  const finish = async () => {
    setFinishing(true);
    try {
      const result = await post<Posted>("/adjustments/batch", diffs.map((line) => ({
        itemId: line.itemId,
        warehouseId: warehouse.id,
        qty: line.counted - line.expected,
        reason: reason.trim(),
      })));
      onPosted(result.docNumber);
    } catch (error) {
      toastErr(error);
      setFinishing(false);
    }
  };

  if (items.error) return <Problem error={items.error} retry={() => items.refetch()} />;

  return (
    <Stack>
      <Text c="dimmed">
        {warehouse.name} ({warehouse.code})
        {onBack ? (
          <Button variant="subtle" size="compact-sm" ml="xs" onClick={onBack}>
            Change
          </Button>
        ) : null}
      </Text>

      {step === 2 ? (
        <>
          <TactileButton size="xl" fullWidth onClick={() => setScanning(true)}>
            <IconBarcode size={28} aria-hidden="true" />
            {lines.length ? "Scan more" : "Open scanner"}
          </TactileButton>
          {note ? <Alert color="orange">{note}</Alert> : null}
          <CountList lines={lines} onCounted={setCounted} />
          <Select
            label="No barcode? Search for the item"
            placeholder="Name or SKU"
            data={(items.data ?? []).map((item) => {
              const why = blockReason(item);
              return { value: String(item.id), label: why ? `${item.name} · ${item.sku} · ${why}` : `${item.name} · ${item.sku}`, disabled: why != null };
            })}
            value={pick}
            onChange={chooseItem}
            searchable
            size="md"
          />
          <Group justify="space-between" mt="md">
            <div />
            <Button size="lg" onClick={() => onStep(3)} disabled={lines.length === 0 || pending}>
              Review
            </Button>
          </Group>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Title order={2} size="lg" fw={500}>
            Review
          </Title>
          <Text>
            Only lines that differ from on hand are posted. Items you did not count are left as they are. A partial count is fine.
          </Text>
          {diffs.length === 0 ? <Text c="dimmed">Nothing differs from on hand, so there is nothing to post.</Text> : <CountList lines={diffs} readOnly />}
          <TextInput
            label="Reason"
            description="This text is stored on the adjustment."
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            required
            size="md"
          />
          <Group justify="space-between" mt="md">
            <Button variant="subtle" onClick={() => onStep(2)}>
              Back to counting
            </Button>
            <TactileButton tone="signal" disabled={finishing || diffs.length === 0 || reason.trim().length < 3} onClick={() => void finish()}>
              <IconCheck size={22} aria-hidden="true" />
              Finish count
            </TactileButton>
          </Group>
        </>
      ) : null}

      {scanning ? (
        <Scanner onScan={onScan} onClose={() => setScanning(false)}>
          <Group justify="space-between">
            <Text c="white" fw={600}>
              {countedUnits} counted
            </Text>
            <Text c="gray.4" size="sm" lineClamp={1}>
              {lines.at(-1)?.name ?? "Aim at a barcode"}
            </Text>
          </Group>
        </Scanner>
      ) : null}
    </Stack>
  );
}

function CountList({ lines, onCounted, readOnly }: { lines: CountLine[]; onCounted?: (itemId: number, value: number | string) => void; readOnly?: boolean }) {
  if (lines.length === 0) return <Text c="dimmed">Nothing counted yet. Scan a barcode or search for an item.</Text>;
  return (
    <Ruled label={readOnly ? "Differences" : "Counted items"}>
      {lines.map((line) => {
        const diff = difference(line);
        return (
          <div key={line.itemId} className="ruled-row" role="listitem" style={{ display: "block" }}>
            <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
              <div style={{ minWidth: 0 }}>
                <div className="ruled-row-title">{line.name}</div>
                <div className="ruled-row-meta">
                  {line.sku} · on hand {line.ready ? line.expected : "…"}
                </div>
              </div>
              <Text fw={700} aria-live="polite" style={{ color: diff?.color, fontVariantNumeric: "tabular-nums" }}>
                {diff?.text ?? "…"}
              </Text>
            </Group>
            {readOnly ? (
              <Text size="sm" mt={6}>
                Counted {line.counted}
              </Text>
            ) : (
              <Group gap={6} wrap="nowrap" mt={8}>
                <ActionIcon size={44} variant="default" aria-label={`One fewer ${line.name}`} disabled={line.counted <= 0} onClick={() => onCounted?.(line.itemId, line.counted - 1)}>
                  <IconMinus />
                </ActionIcon>
                <NumberInput
                  aria-label={`Counted ${line.name}`}
                  value={line.counted}
                  onChange={(value) => onCounted?.(line.itemId, value)}
                  min={0}
                  allowDecimal={false}
                  allowNegative={false}
                  hideControls
                  clampBehavior="strict"
                  w={88}
                  styles={{ input: { height: 44, minHeight: 44, textAlign: "center", fontSize: 20, fontWeight: 700 } }}
                />
                <ActionIcon size={44} variant="default" aria-label={`One more ${line.name}`} onClick={() => onCounted?.(line.itemId, line.counted + 1)}>
                  <IconPlus />
                </ActionIcon>
              </Group>
            )}
          </div>
        );
      })}
    </Ruled>
  );
}

function PostedStep({ docNumber, onAnother }: { docNumber: string; onAnother: () => void }) {
  return (
    <Stack>
      <Title order={2} size="lg" fw={500}>
        Stock count posted
      </Title>
      <Text>
        {docNumber} records every difference from this count.
      </Text>
      <TactileButton tone="signal" fullWidth to={`/adjustments/${encodeURIComponent(docNumber)}`}>
        Open {docNumber}
      </TactileButton>
      <Button variant="default" onClick={onAnother}>
        Count again
      </Button>
    </Stack>
  );
}
