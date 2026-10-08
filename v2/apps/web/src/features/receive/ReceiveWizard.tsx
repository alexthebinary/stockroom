import { barcodeKey, parseGs1 } from "@pi/domain";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { IconAlertTriangle, IconBarcode, IconCheck, IconCloudOff, IconFileText, IconMinus, IconPlus, IconQuestionMark } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { toastErr } from "../../components/ui";
import { ApiError, get, patch, post } from "../../lib/api";
import type { Item, Vendor, Warehouse } from "../../lib/types";
import { type ScanFeedback, Scanner } from "../scan/Scanner";
import { enqueue, eventsFor, flush, forget, outbox, type QueuedEvent } from "./outbox";

type Expected = { id: number; number: string; billingStatus: string; vendor: Vendor | null; lines: { id: number; itemId: number; item: Item; outstanding: number }[] }[];
type Session = { id: number; clientId: string; warehouseId: number; vendorId: number | null; poId: number | null; status: string };
type Result = { poIds: number[]; receiptIds: number[]; draftBillIds: number[]; landedUnits: number; heldUnits: number; unknown: { code: string | null; name: string | null; qty: number }[] };
type SlipRead = {
  available: boolean;
  ok?: boolean;
  message?: string;
  vendor: Vendor | null;
  po: { id: number; number: string } | null;
  slip: { documentNumber: string | null };
  lines: { itemId: number | null; item: Item | null; description: string; quantity: number; unitPriceCents: number | null; serials: string[] }[];
};

const STATE_KEY = "pi.receive";
const remember = (state: { sessionId: number; step: number } | null) => {
  try {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STATE_KEY);
  } catch {
    // storage blocked: the delivery still lives on the server
  }
};
const recalled = (): { sessionId: number; step: number } | null => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
  } catch {
    return null;
  }
};
const lastWarehouse = () => {
  try {
    return Number(localStorage.getItem("pi.warehouse")) || null;
  } catch {
    return null;
  }
};

/**
 * The clerk's job, one question per screen: where are you, who is it from,
 * scan it, check it, done. Works one-handed with gloves (big targets), keeps
 * scanning with no signal, and never asks the clerk an accounting question.
 */
export function ReceiveWizard() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const resume = recalled();
  const [step, setStep] = useState(resume?.step ?? 0);
  const [sessionId, setSessionId] = useState<number | null>(resume?.sessionId ?? null);
  const [warehouseId, setWarehouseId] = useState<number | null>(lastWarehouse());
  const [result, setResult] = useState<Result | null>(null);
  const session = useQuery({ queryKey: ["session", sessionId], queryFn: () => get<Session>(`/scan-sessions/${sessionId}`), enabled: sessionId != null });
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });

  useEffect(() => {
    if (sessionId) remember({ sessionId, step });
  }, [sessionId, step]);
  useEffect(() => {
    if (warehouses.data?.length === 1 && !warehouseId) setWarehouseId(warehouses.data[0]!.id);
  }, [warehouses.data, warehouseId]);
  useEffect(() => {
    if (session.data && session.data.status !== "OPEN" && step < 4) {
      remember(null);
      setSessionId(null);
      setStep(0);
    }
  }, [session.data, step]);

  const start = async (who: { vendorId?: number | null; poId?: number | null }) => {
    try {
      const created = await post<Session>("/scan-sessions", { clientId: crypto.randomUUID(), warehouseId, ...who });
      setSessionId(created.id);
      setStep(2);
    } catch (error) {
      toastErr(error);
    }
  };

  const finishOver = () => {
    remember(null);
    setSessionId(null);
    setResult(null);
    setStep(0);
    queryClient.invalidateQueries();
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={1}>Receive a delivery</Title>
        <Badge variant="outline" color="gray">
          Step {Math.min(step + 1, 5)} of 5
        </Badge>
      </Group>
      <Progress value={(Math.min(step + 1, 5) / 5) * 100} color="lime" size="sm" />
      {step === 0 && (
        <WhereStep
          warehouses={warehouses.data ?? []}
          value={warehouseId}
          onPick={(id) => {
            setWarehouseId(id);
            try {
              localStorage.setItem("pi.warehouse", String(id));
            } catch {
              // fine
            }
            setStep(1);
          }}
        />
      )}
      {step === 1 && warehouseId && <WhoStep warehouseId={warehouseId} onStart={start} onBack={() => setStep(0)} />}
      {step >= 2 && step <= 3 && session.data && (
        <ScanAndCheck
          session={session.data}
          step={step}
          onStep={setStep}
          onDone={(r) => {
            setResult(r);
            setStep(4);
            remember(null);
          }}
          onAbandon={async () => {
            await post(`/scan-sessions/${session.data!.id}/abandon`).catch(() => {});
            await forget(session.data!.id);
            finishOver();
          }}
        />
      )}
      {step === 4 && result && <DoneStep result={result} onAnother={finishOver} onHome={() => navigate("/")} />}
    </Stack>
  );
}

function WhereStep({ warehouses, value, onPick }: { warehouses: Warehouse[]; value: number | null; onPick: (id: number) => void }) {
  return (
    <Stack>
      <Text size="lg" fw={500}>
        Where is it arriving?
      </Text>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        {warehouses.map((w) => (
          <UnstyledButton key={w.id} onClick={() => onPick(w.id)}>
            <Card withBorder padding="lg" style={{ minHeight: 76, borderColor: w.id === value ? "var(--ink)" : undefined }}>
              <Text fw={600} size="lg">
                {w.name}
              </Text>
              <Text size="sm" c="dimmed">
                {w.code}
              </Text>
            </Card>
          </UnstyledButton>
        ))}
      </SimpleGrid>
      {warehouses.length === 0 ? <Alert color="orange">No warehouses yet. An admin adds them under Settings.</Alert> : null}
    </Stack>
  );
}

function WhoStep({ warehouseId, onStart, onBack }: { warehouseId: number; onStart: (who: { vendorId?: number | null; poId?: number | null }) => void; onBack: () => void }) {
  const expected = useQuery({ queryKey: ["expected", warehouseId], queryFn: () => get<Expected>(`/receiving/expected?warehouseId=${warehouseId}`) });
  const vendors = useQuery({ queryKey: ["vendors", "SUPPLIER"], queryFn: () => get<Vendor[]>("/vendors?kind=SUPPLIER") });
  const ai = useQuery({ queryKey: ["ai"], queryFn: () => get<{ available: boolean }>("/ai/status") });
  const [vendorId, setVendorId] = useState<string | null>(null);
  return (
    <Stack>
      <Text size="lg" fw={500}>
        Who is it from?
      </Text>
      <Coach id="receive-who" title="Not sure? That's fine.">
        Pick the order if you see it below, or just the supplier. If you don't know, tap "Not sure" — accounting will sort it out from the paperwork. You never need to know prices.
      </Coach>
      {(expected.data ?? []).length > 0 ? (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Expected here
          </Text>
          {expected.data!.map((po) => (
            <UnstyledButton key={po.id} onClick={() => onStart({ poId: po.id, vendorId: po.vendor?.id })}>
              <Card withBorder padding="md">
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>{po.vendor?.name ?? "Vendor not set"}</Text>
                    <Text size="sm" c="dimmed">
                      {po.number} · {po.lines.map((l) => `${l.outstanding} × ${l.item.name}`).join(", ")}
                    </Text>
                  </div>
                  <IconBarcode />
                </Group>
              </Card>
            </UnstyledButton>
          ))}
        </Stack>
      ) : null}
      <Card withBorder>
        <Stack>
          <Select label="Or pick the supplier" data={(vendors.data ?? []).map((v) => ({ value: String(v.id), label: v.name }))} value={vendorId} onChange={setVendorId} searchable size="md" />
          <Button size="lg" disabled={!vendorId} onClick={() => onStart({ vendorId: Number(vendorId) })}>
            Start scanning
          </Button>
        </Stack>
      </Card>
      {ai.data?.available ? (
        <Text size="sm" c="dimmed">
          <IconFileText size={14} /> You can photograph the packing slip on the next screen and it will be read for you.
        </Text>
      ) : null}
      <Group justify="space-between">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button variant="default" size="md" leftSection={<IconQuestionMark size={18} />} onClick={() => onStart({})}>
          Not sure
        </Button>
      </Group>
    </Stack>
  );
}

type Line = { key: string; itemId: number | null; item: Item | null; code: string | null; name: string | null; qty: number; serials: string[] };

function ScanAndCheck({ session, step, onStep, onDone, onAbandon }: { session: Session; step: number; onStep: (n: number) => void; onDone: (r: Result) => void; onAbandon: () => void }) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const expected = useQuery({ queryKey: ["expected", session.warehouseId], queryFn: () => get<Expected>(`/receiving/expected?warehouseId=${session.warehouseId}`) });
  const ai = useQuery({ queryKey: ["ai"], queryFn: () => get<{ available: boolean }>("/ai/status") });
  const events = useLiveQuery(() => eventsFor(session.id), [session.id]) ?? [];
  const [scanning, setScanning] = useState(false);
  const [pendingSerialFor, setPendingSerialFor] = useState<Item | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [finishing, setFinishing] = useState(false);
  const [slip, setSlip] = useState<SlipRead | null>(null);
  const [reading, setReading] = useState(false);
  const [naming, setNaming] = useState<Line | null>(null);

  // Keep trying to send: on every scan, on reconnect, and every 10 seconds.
  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flush(session.id);
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(() => void flush(session.id), 10_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(timer);
    };
  }, [session.id]);

  const byKey = useMemo(() => {
    const map = new Map<string, Item>();
    for (const item of items.data ?? []) {
      for (const b of item.barcodes ?? []) map.set(b.code, item);
      map.set(item.sku.toUpperCase(), item);
    }
    return map;
  }, [items.data]);
  const itemById = (id: number | null) => (items.data ?? []).find((i) => i.id === id) ?? null;

  const lines: Line[] = useMemo(() => {
    const map = new Map<string, Line>();
    for (const e of events) {
      const key = e.itemId ? `i${e.itemId}` : `c${e.code ?? e.unknownName}`;
      const line = map.get(key) ?? { key, itemId: e.itemId, item: itemById(e.itemId), code: e.code, name: e.unknownName, qty: 0, serials: [] };
      line.qty += e.qty;
      line.name ??= e.unknownName;
      if (e.serial) line.serials = e.qty > 0 ? [...line.serials, e.serial] : line.serials.filter((s) => s !== e.serial);
      map.set(key, line);
    }
    return [...map.values()].filter((l) => l.qty !== 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, items.data]);
  const pending = events.filter((e) => !e.sent).length;
  const po = expected.data?.find((p) => p.id === session.poId) ?? null;

  const record = useCallback(
    async (e: Omit<QueuedEvent, "sent" | "clientId" | "capturedAt" | "sessionId">) => {
      await enqueue({ ...e, sessionId: session.id });
      void flush(session.id);
    },
    [session.id],
  );

  const onScan = async (raw: string): Promise<ScanFeedback> => {
    const gs1 = parseGs1(raw);
    const item = byKey.get(barcodeKey(raw)) ?? null;
    if (pendingSerialFor && !item) {
      await record({ code: null, itemId: pendingSerialFor.id, qty: 1, serial: raw.trim(), unknownName: null, photo: null, source: "BARCODE" });
      setPendingSerialFor(null);
      return "ok";
    }
    if (item?.trackingMode === "SERIAL" && !gs1?.serial) {
      setPendingSerialFor(item);
      return "warn";
    }
    await record({ code: raw, itemId: item?.id ?? null, qty: 1, serial: gs1?.serial ?? null, unknownName: null, photo: null, source: "BARCODE" });
    return item ? "ok" : "warn";
  };

  const bump = (line: Line, delta: number) => record({ code: line.code, itemId: line.itemId, qty: delta, serial: null, unknownName: line.name, photo: null, source: "MANUAL" });

  const readSlip = async (dataUrl: string) => {
    setScanning(false);
    setReading(true);
    try {
      const read = await post<SlipRead>("/ai/read-slip", { image: dataUrl, vendorId: session.vendorId });
      if (!read.available || read.ok === false) {
        toastErr(new Error(read.message ?? "The reader isn't set up here. Scan the boxes instead."));
      } else {
        setSlip(read);
        await patch(`/scan-sessions/${session.id}`, {
          vendorId: session.vendorId ?? read.vendor?.id ?? null,
          poId: session.poId ?? read.po?.id ?? null,
          slipRead: { documentNumber: read.slip.documentNumber, lines: read.lines.map((l) => ({ itemId: l.itemId, unitPriceCents: l.unitPriceCents })) },
        });
      }
    } catch (error) {
      toastErr(error);
    } finally {
      setReading(false);
    }
  };

  const acceptSlip = async () => {
    for (const line of slip?.lines ?? []) {
      if (!line.itemId) continue;
      if (line.item?.trackingMode === "SERIAL") {
        for (const serial of line.serials.slice(0, line.quantity)) await record({ code: null, itemId: line.itemId, qty: 1, serial, unknownName: null, photo: null, source: "AI" });
      } else {
        await record({ code: null, itemId: line.itemId, qty: line.quantity, serial: null, unknownName: null, photo: null, source: "AI" });
      }
    }
    setSlip(null);
  };

  const finish = async () => {
    setFinishing(true);
    try {
      const left = await flush(session.id);
      if (left > 0) throw new ApiError(`${left} scan(s) are still on this phone. They'll send when you have signal — then finish.`, 0);
      const total = await outbox.events.where({ sessionId: session.id }).count();
      const result = await post<Result>(`/scan-sessions/${session.id}/submit`, { expectedEventCount: total });
      await forget(session.id);
      onDone(result);
    } catch (error) {
      toastErr(error);
    } finally {
      setFinishing(false);
    }
  };

  const missingSerials = lines.filter((l) => l.item?.trackingMode === "SERIAL" && l.serials.length < l.qty);
  const unknown = lines.filter((l) => !l.itemId);
  const counted = lines.reduce((s, l) => s + (l.itemId ? l.qty : 0), 0);

  return (
    <Stack>
      {!online || pending > 0 ? (
        <Alert color={online ? "blue" : "orange"} icon={<IconCloudOff size={18} />}>
          {online ? `Sending ${pending} scan(s)…` : `No signal. ${pending} scan(s) are saved on this phone and will send by themselves.`}
        </Alert>
      ) : null}

      {step === 2 && (
        <>
          <Coach id="scanner" title="How scanning works">
            Aim the box's barcode into the white frame. A buzz and a lime frame mean it counted; orange means look at the screen (a new item, or a serial is needed). The camera stays open — keep going box after box.
          </Coach>
          {po ? (
            <Card withBorder>
              <Text size="sm" c="dimmed">
                Expected on {po.number}
              </Text>
              {po.lines.map((l) => {
                const got = lines.find((x) => x.itemId === l.itemId)?.qty ?? 0;
                return (
                  <Group key={l.id} justify="space-between">
                    <Text>{l.item.name}</Text>
                    <Text fw={600} c={got === l.outstanding ? "lime.8" : undefined}>
                      {got} / {l.outstanding}
                    </Text>
                  </Group>
                );
              })}
            </Card>
          ) : null}
          <Button size="xl" h={72} leftSection={<IconBarcode size={28} />} onClick={() => setScanning(true)}>
            {counted ? "Scan more" : "Open scanner"}
          </Button>
          {reading ? (
            <Group>
              <Loader size="sm" />
              <Text>Reading the packing slip…</Text>
            </Group>
          ) : null}
          <LineList lines={lines} onBump={bump} onName={setNaming} />
          <AddByHand items={items.data ?? []} onAdd={(item, qty) => record({ code: null, itemId: item.id, qty, serial: null, unknownName: null, photo: null, source: "MANUAL" })} />
          <Group justify="space-between" mt="md">
            <Button variant="subtle" color="red" onClick={onAbandon}>
              Abandon delivery
            </Button>
            <Button size="lg" onClick={() => onStep(3)} disabled={lines.length === 0}>
              Check & finish
            </Button>
          </Group>
        </>
      )}

      {step === 3 && (
        <>
          <Text size="lg" fw={500}>
            Does this match what's in front of you?
          </Text>
          <LineList lines={lines} onBump={bump} onName={setNaming} />
          {missingSerials.map((l) => (
            <Alert key={l.key} color="orange" icon={<IconAlertTriangle size={18} />}>
              {l.item?.name}: {l.qty} counted but {l.serials.length} serial(s). Scan each unit's serial label (or type it).
            </Alert>
          ))}
          {unknown.length ? (
            <Alert color="blue">
              {unknown.length} unknown item(s) will be set aside for accounting to match. They don't stop you finishing.
            </Alert>
          ) : null}
          <Group justify="space-between" mt="md">
            <Button variant="subtle" onClick={() => onStep(2)}>
              Back to scanning
            </Button>
            <Button size="lg" color="lime" leftSection={<IconCheck />} loading={finishing} disabled={missingSerials.length > 0} onClick={finish}>
              Finish delivery
            </Button>
          </Group>
        </>
      )}

      {scanning ? (
        <Scanner
          onScan={onScan}
          onClose={() => {
            setScanning(false);
            setPendingSerialFor(null);
          }}
          prompt={pendingSerialFor ? `Now scan the serial for ${pendingSerialFor.name}` : undefined}
          onPhoto={ai.data?.available ? readSlip : undefined}
        >
          <Group justify="space-between">
            <Text c="white" fw={600}>
              {counted} counted
            </Text>
            <Text c="gray.4" size="sm" lineClamp={1}>
              {lines.at(-1)?.item?.name ?? lines.at(-1)?.code ?? "Aim at a barcode"}
            </Text>
          </Group>
        </Scanner>
      ) : null}

      <Modal opened={slip != null} onClose={() => setSlip(null)} title="From the packing slip" fullScreen>
        {slip ? (
          <Stack>
            <Text size="sm" c="dimmed">
              {slip.vendor ? `From ${slip.vendor.name}` : "Vendor not recognised"}
              {slip.po ? ` · ${slip.po.number}` : ""}. Check each line against the boxes, then add them.
            </Text>
            {slip.lines.map((l, i) => (
              <Card key={i} withBorder>
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={600}>{l.item?.name ?? l.description}</Text>
                    <Text size="sm" c={l.itemId ? "dimmed" : "orange"}>
                      {l.itemId ? `${l.quantity} unit(s)` : "Not matched to an item — scan these boxes instead"}
                      {l.serials.length ? ` · S/N ${l.serials.join(", ")}` : ""}
                    </Text>
                  </div>
                  {l.itemId ? <IconCheck color="var(--mantine-color-lime-7)" /> : <IconQuestionMark />}
                </Group>
              </Card>
            ))}
            <Button size="lg" onClick={acceptSlip}>
              Add the matched lines
            </Button>
          </Stack>
        ) : null}
      </Modal>

      <NameUnknown line={naming} onClose={() => setNaming(null)} onSave={async (name) => naming && record({ code: naming.code, itemId: null, qty: 0, serial: null, unknownName: name, photo: null, source: "MANUAL" })} />
    </Stack>
  );
}

function LineList({ lines, onBump, onName }: { lines: Line[]; onBump: (l: Line, d: number) => void; onName: (l: Line) => void }) {
  if (lines.length === 0) return <Text c="dimmed">Nothing scanned yet.</Text>;
  return (
    <Stack gap="xs">
      {lines.map((l) => (
        <Card key={l.key} withBorder padding="sm">
          <Group justify="space-between" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {l.item?.name ?? l.name ?? "Unknown item"}
              </Text>
              <Text size="sm" c={l.itemId ? "dimmed" : "orange"} truncate>
                {l.itemId ? l.item?.sku : `Code ${l.code ?? "—"} · `}
                {!l.itemId ? (
                  <Text span inherit td="underline" onClick={() => onName(l)} style={{ cursor: "pointer" }}>
                    describe it
                  </Text>
                ) : null}
                {l.serials.length ? ` · ${l.serials.join(", ")}` : ""}
              </Text>
            </div>
            <Group gap={6} wrap="nowrap">
              <ActionIcon size={44} variant="default" onClick={() => onBump(l, -1)} aria-label={`One fewer ${l.item?.name ?? "item"}`} disabled={l.qty <= 0 || l.serials.length > 0}>
                <IconMinus />
              </ActionIcon>
              <Text fw={700} size="xl" w={40} ta="center">
                {l.qty}
              </Text>
              <ActionIcon size={44} variant="default" onClick={() => onBump(l, 1)} aria-label={`One more ${l.item?.name ?? "item"}`} disabled={l.item?.trackingMode === "SERIAL"}>
                <IconPlus />
              </ActionIcon>
            </Group>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

function AddByHand({ items, onAdd }: { items: Item[]; onAdd: (item: Item, qty: number) => void }) {
  const [itemId, setItemId] = useState<string | null>(null);
  const counted = items.filter((i) => i.trackingMode === "NONE");
  return (
    <Group align="flex-end" wrap="nowrap">
      <Select
        label="No barcode? Pick the item"
        placeholder="Search by name or SKU"
        data={counted.map((i) => ({ value: String(i.id), label: `${i.name} · ${i.sku}` }))}
        value={itemId}
        onChange={setItemId}
        searchable
        style={{ flex: 1 }}
        size="md"
      />
      <Button
        size="md"
        variant="light"
        disabled={!itemId}
        onClick={() => {
          const item = counted.find((i) => String(i.id) === itemId);
          if (item) onAdd(item, 1);
          setItemId(null);
        }}
      >
        Add 1
      </Button>
    </Group>
  );
}

function NameUnknown({ line, onClose, onSave }: { line: Line | null; onClose: () => void; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState("");
  return (
    <Modal opened={line != null} onClose={onClose} title="What is it?">
      <Stack>
        <Text size="sm" c="dimmed">
          A few words for accounting, e.g. "blue box, 6-axis arm". They'll match it to an item.
        </Text>
        <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} size="md" autoFocus />
        <Button
          onClick={async () => {
            await onSave(name);
            setName("");
            onClose();
          }}
          disabled={!name.trim()}
        >
          Save
        </Button>
      </Stack>
    </Modal>
  );
}

function DoneStep({ result, onAnother, onHome }: { result: Result; onAnother: () => void; onHome: () => void }) {
  return (
    <Stack align="stretch">
      <Card withBorder padding="xl">
        <Stack gap="xs">
          <IconCheck size={40} color="var(--mantine-color-lime-7)" />
          <Title order={2} className="rule-in" style={{ alignSelf: "flex-start" }}>
            Delivery received
          </Title>
          {result.landedUnits > 0 ? <Text size="lg">{result.landedUnits} unit(s) are in stock now — their bill was already posted.</Text> : null}
          {result.heldUnits > 0 ? (
            <Text size="lg">
              {result.heldUnits} unit(s) are counted and waiting for accounting to post the bill. They become sellable stock then — nothing more for you to do.
            </Text>
          ) : null}
          {result.unknown.length > 0 ? <Text>{result.unknown.length} unknown item(s) were set aside for accounting to match.</Text> : null}
        </Stack>
      </Card>
      <Button size="xl" onClick={onAnother}>
        Receive another delivery
      </Button>
      <Button variant="subtle" onClick={onHome} component={Link} to="/">
        Back to home
      </Button>
    </Stack>
  );
}
