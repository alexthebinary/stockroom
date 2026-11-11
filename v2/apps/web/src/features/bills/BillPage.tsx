import { type AllocationBasis, formatUsd, landedCost, parseUsd } from "@pi/domain";
import {
  Alert,
  Anchor,
  Button,
  Card,
  FileButton,
  Group,
  Image,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPaperclip } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { HoldToConfirmButton } from "../../components/kitchen/HoldToConfirmButton";
import { plural, formatDate, Loading, Money, PageHeader, Problem, Stat, StatusBadge, toInputDate, toastErr, toastOk, usd } from "../../components/ui";
import { useBlurErrors } from "../../components/form";
import { del, get, patch, post } from "../../lib/api";
import type { Bill, PurchaseOrder, Vendor } from "../../lib/types";
import { MatchPanel, type OrderMatch } from "./MatchPanel";

type Rule = { role: string; account: { code: string; name: string } };
type Payment = { id: number; number: string; direction: "OUT" | "IN"; amountCents: number; method: string; paidAt: string; status: string; actor: string };
type Credit = { id: number; number: string; kind: string; totalCents: number; date: string; memo: string | null; actor: string; lines: { id: number; itemId: number; qty: number; amountCents: number }[] };
type FullBill = Bill & { payments: Payment[]; credits: Credit[]; allocations: { poLineId: number; amountCents: number; inboundCents: number; onHandCents: number; soldCents: number }[]; match: OrderMatch[] | null };

const dollars = (cents: number) => (cents / 100).toFixed(2);
const cents = (value: string | number) => parseUsd(String(value)) ?? 0;

export function BillPage() {
  const { id } = useParams();
  const bill = useQuery({ queryKey: ["bill", id], queryFn: () => get<FullBill>(`/bills/${id}`) });
  if (bill.error) return <Problem error={bill.error} retry={bill.refetch} />;
  if (!bill.data) return <Loading />;
  const b = bill.data;
  if (b.status === "DRAFT" && b.kind === "INVENTORY") return <DraftInventoryBill bill={b} key={b.version} />;
  if (b.status === "DRAFT") return <DraftFreightBill bill={b} key={b.version} />;
  return <PostedBill bill={b} />;
}

function useRules() {
  const rules = useQuery({ queryKey: ["posting-rules"], queryFn: () => get<Rule[]>("/posting-rules") });
  return (role: string) => {
    const r = rules.data?.find((x) => x.role === role);
    return r ? `${r.account.code} ${r.account.name}` : role;
  };
}

/**
 * The review: who sent it, their invoice number, what they charged per line,
 * freight. Every change re-prices the lines on the spot with the same code
 * that posts them, so what you see is exactly what will be booked.
 */
function DraftInventoryBill({ bill }: { bill: FullBill }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const account = useRules();
  const vendors = useQuery({ queryKey: ["vendors", "SUPPLIER"], queryFn: () => get<Vendor[]>("/vendors?kind=SUPPLIER") });
  const [form, setForm] = useState({
    vendorId: bill.vendorId ? String(bill.vendorId) : null,
    vendorInvoiceNumber: bill.vendorInvoiceNumber ?? "",
    billDate: toInputDate(bill.billDate),
    termsDays: bill.termsDays,
    freight: dollars(bill.freightCents),
    basis: bill.allocationBasis as AllocationBasis,
    notes: bill.notes ?? "",
    attachment: typeof bill.attachment === "string" ? bill.attachment : null,
    lines: bill.lines.map((l) => ({ id: l.id, qty: l.qty, unitCost: dollars(l.unitCostCents), discount: dollars(l.discountCents) })),
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!form.vendorId || form.termsDays !== bill.termsDays) return;
    const v = vendors.data?.find((x) => String(x.id) === form.vendorId);
    if (v && !bill.vendorId) setForm((f) => ({ ...f, termsDays: v.paymentTermsDays }));
  }, [form.vendorId, vendors.data, bill.vendorId, bill.termsDays, form.termsDays]);

  const priced = useMemo(() => {
    try {
      const active = form.lines.filter((l) => l.qty > 0);
      return landedCost(
        active.map((l) => ({ key: String(l.id), qty: l.qty, unitCostCents: cents(l.unitCost), discountCents: cents(l.discount) })),
        cents(form.freight),
        form.basis,
      );
    } catch (error) {
      return error as Error;
    }
  }, [form.lines, form.freight, form.basis]);
  const total = priced instanceof Error ? 0 : priced.reduce((s, l) => s + l.landedCents, 0);
  const due = new Date(new Date(form.billDate).getTime() + form.termsDays * 86_400_000);
  const landingNow = bill.lines.reduce((s, l) => {
    const qty = form.lines.find((x) => x.id === l.id)?.qty ?? 0;
    const p = l.poLine;
    return s + (p ? Math.min(p.qtyHeld, p.qtyBilled + qty - p.qtyLanded) : 0);
  }, 0);

  const save = async () => {
    const saved = await patch<Bill>(`/bills/${bill.id}`, {
      version: bill.version,
      vendorId: form.vendorId ? Number(form.vendorId) : null,
      vendorInvoiceNumber: form.vendorInvoiceNumber || null,
      billDate: form.billDate,
      termsDays: form.termsDays,
      freightCents: cents(form.freight),
      allocationBasis: form.basis,
      notes: form.notes || null,
      attachment: form.attachment,
      lines: form.lines.map((l) => ({ id: l.id, qty: l.qty, unitCostCents: cents(l.unitCost), discountCents: cents(l.discount) })),
    });
    return saved;
  };
  const run = async (what: "save" | "post") => {
    setBusy(true);
    try {
      const saved = await save();
      if (what === "post") {
        await post(`/bills/${bill.id}/post`, { version: saved.version });
        toastOk(`${bill.number} posted${landingNow ? ` — ${plural(landingNow, "unit")} now in stock` : ""}`);
      } else toastOk("Saved");
      await queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
      await queryClient.invalidateQueries({ queryKey: ["bill", String(bill.id)] });
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    try {
      await del(`/bills/${bill.id}`);
      await queryClient.invalidateQueries();
      navigate("/bills");
    } catch (error) {
      toastErr(error);
    }
  };
  const setLine = (id: number, patchLine: Partial<(typeof form.lines)[number]>) => setForm({ ...form, lines: form.lines.map((l) => (l.id === id ? { ...l, ...patchLine } : l)) });

  return (
    <Stack gap="lg">
      <PageHeader
        back={{ to: "/bills", label: "Bills" }}
        title={`Review ${bill.number}`}
        subtitle={
          <>
            {bill.source === "SCAN" ? "Drafted from what the dock received" : "Drafted from the purchase order"}
            {bill.po ? (
              <>
                {" · "}
                <Anchor component={Link} to={`/orders/${bill.poId}`} inherit>
                  {bill.po.number}
                </Anchor>
              </>
            ) : null}
          </>
        }
        action={<StatusBadge status="DRAFT" />}
      />
      <div className="detail-grid">
      <div className="detail-main">
      <Coach id="bill-review" title="What posting does">
        Posting books Dr Inventory / Cr Accounts Payable for the total, with freight spread over the lines (by value unless you choose quantity). Units the dock is holding for this bill become sellable stock at that landed cost, in the same moment.
      </Coach>

      <Card withBorder className="section">
        <Title order={3} mb="sm">
          Vendor and invoice
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label="Vendor" data={(vendors.data ?? []).map((v) => ({ value: String(v.id), label: v.name }))} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} searchable required error={!form.vendorId ? "Needed to post" : undefined} />
          <TextInput label="Vendor's invoice number" value={form.vendorInvoiceNumber} onChange={(e) => setForm({ ...form, vendorInvoiceNumber: e.currentTarget.value })} required error={!form.vendorInvoiceNumber ? "Needed to post" : undefined} />
          <TextInput type="date" label="Bill date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.currentTarget.value })} />
          <NumberInput label="Terms (days)" value={form.termsDays} onChange={(v) => setForm({ ...form, termsDays: Number(v) || 0 })} min={0} max={365} description={`Due ${formatDate(due)}`} />
        </SimpleGrid>
        <Group mt="md">
          <FileButton accept="image/*,application/pdf" onChange={(file) => file && readFile(file).then((attachment) => setForm({ ...form, attachment }))}>
            {(props) => (
              <Button variant="light" leftSection={<IconPaperclip size={16} />} {...props}>
                {form.attachment ? "Replace the vendor's bill" : "Attach the vendor's bill"}
              </Button>
            )}
          </FileButton>
          {form.attachment?.startsWith("data:image/") ? <Image src={form.attachment} h={64} w="auto" radius="sm" alt="Attached bill" /> : form.attachment ? <span className="chip" data-tone="none">PDF attached</span> : null}
        </Group>
      </Card>

      <Card withBorder className="section">
        <Title order={3} mb="sm">
          Lines
        </Title>
        <Stack gap="sm">
          {bill.lines.map((l) => {
            const f = form.lines.find((x) => x.id === l.id)!;
            const p = !(priced instanceof Error) ? priced.find((x) => x.key === String(l.id)) : undefined;
            return (
              <div key={l.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <Group justify="space-between" mb={6} wrap="nowrap">
                  <Text fw={600} truncate>
                    {l.item?.name}
                  </Text>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {l.poLine ? `received ${l.poLine.qtyReceived} · ordered ${l.poLine.qtyOrdered}` : ""}
                  </Text>
                </Group>
                <SimpleGrid cols={{ base: 3 }} spacing="xs">
                  <NumberInput label="Qty billed" value={f.qty} min={0} onChange={(v) => setLine(l.id, { qty: Number(v) || 0 })} />
                  <TextInput label="Unit cost $" value={f.unitCost} inputMode="decimal" onChange={(e) => setLine(l.id, { unitCost: e.currentTarget.value })} />
                  <TextInput label="Discount $" value={f.discount} inputMode="decimal" onChange={(e) => setLine(l.id, { discount: e.currentTarget.value })} />
                </SimpleGrid>
                {l.poLine && f.qty !== l.poLine.qtyReceived - l.poLine.qtyBilled ? (
                  <Text size="sm" c="var(--warn-fg)" mt={4}>
                    Billing {f.qty}, but {l.poLine.qtyReceived - l.poLine.qtyBilled} arrived unbilled. The rest stays {f.qty > l.poLine.qtyReceived - l.poLine.qtyBilled ? "inbound until it arrives" : "waiting for another bill"}.
                  </Text>
                ) : null}
                {p ? (
                  <Text size="sm" mt={4}>
                    {usd(p.goodsCents)} + {usd(p.freightCents)} freight = <b>{usd(p.landedCents)}</b> · lands at <b>{formatUsd(Math.round(p.landedUnitCents))}</b> each
                  </Text>
                ) : null}
              </div>
            );
          })}
        </Stack>
      </Card>

      <MatchPanel match={bill.match} current={form.lines.map((l) => ({ billLineId: l.id, qty: l.qty, unitCostCents: parseUsd(l.unitCost) }))} />

      <Card withBorder className="section">
        <Title order={3} mb="sm">
          Freight on this bill
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Shipping charged by the vendor $" value={form.freight} inputMode="decimal" onChange={(e) => setForm({ ...form, freight: e.currentTarget.value })} />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Spread it by
            </Text>
            <SegmentedControl value={form.basis} onChange={(v) => setForm({ ...form, basis: v as AllocationBasis })} data={[{ value: "VALUE", label: "Line value" }, { value: "QTY", label: "Units" }]} />
          </div>
        </SimpleGrid>
        <Text size="sm" c="dimmed" mt="xs">
          A separate carrier's invoice? Post it as a <Anchor component={Link} to={`/bills/freight/new?po=${bill.poId}`}>freight bill</Anchor> against this order instead.
        </Text>
      </Card>

      <Card withBorder className="section">
        <Title order={3} mb="sm">
          What will be booked
        </Title>
        {priced instanceof Error ? (
          <Alert color="orange">{priced.message}</Alert>
        ) : (
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>Dr {account("inventoryInbound")}</Table.Td>
                <Table.Td ta="right">
                  <Money cents={total} />
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>Cr {account("payable")}</Table.Td>
                <Table.Td ta="right">
                  <Money cents={total} />
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        )}
        {landingNow > 0 ? (
          <Text size="sm" mt="xs">
            Then {plural(landingNow, "unit")} waiting at the dock {landingNow === 1 ? "lands" : "land"}: Dr {account("inventoryOnHand")} / Cr {account("inventoryInbound")}.
          </Text>
        ) : null}
      </Card>

      <Group justify="space-between">
        <Button variant="subtle" color="red" onClick={discard}>
          Discard draft
        </Button>
        <Button variant="default" onClick={() => run("save")} loading={busy}>
          Save for later
        </Button>
      </Group>

      </div>
      <aside className="detail-aside draft-aside no-print" aria-label="Total and posting">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase">
            Total
          </Text>
          <Text fw={600} size="xl">
            <Money cents={total} />
          </Text>
        </div>
        <HoldToConfirmButton onConfirm={() => run("post")} busy={busy} disabled={!form.vendorId || !form.vendorInvoiceNumber || priced instanceof Error || total <= 0} confirmed="Posting…">
          Hold to post bill
        </HoldToConfirmButton>
      </aside>
      </div>
    </Stack>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** A carrier's bill: freight-in spread over the orders it carried, or freight-out as an expense. */
function DraftFreightBill({ bill }: { bill: FullBill }) {
  const queryClient = useQueryClient();
  const carriers = useQuery({ queryKey: ["vendors"], queryFn: () => get<Vendor[]>("/vendors") });
  const orders = useQuery({ queryKey: ["orders", "ALL"], queryFn: () => get<PurchaseOrder[]>("/purchase-orders?lifecycle=ALL") });
  const [form, setForm] = useState({
    vendorId: bill.vendorId ? String(bill.vendorId) : null,
    invoice: bill.vendorInvoiceNumber ?? "",
    amount: dollars(bill.totalCents),
    targets: bill.targetPoIds.map(String),
    basis: bill.allocationBasis as AllocationBasis,
    billDate: toInputDate(bill.billDate),
  });
  const preview = useQuery({ queryKey: ["freight-preview", bill.id, bill.version], queryFn: () => get<{ poLineId: number; amountCents: number; item: { name: string } }[]>(`/bills/${bill.id}/freight-preview`), enabled: bill.kind === "FREIGHT_IN" });
  const [busy, setBusy] = useState(false);
  const run = async (what: "save" | "post") => {
    setBusy(true);
    try {
      const saved = await patch<Bill>(`/bills/${bill.id}`, {
        version: bill.version,
        vendorId: form.vendorId ? Number(form.vendorId) : null,
        vendorInvoiceNumber: form.invoice || null,
        billDate: form.billDate,
        allocationBasis: form.basis,
        targetPoIds: form.targets.map(Number),
        lines: [{ id: bill.lines[0]!.id, amountCents: cents(form.amount) }],
      });
      if (what === "post") {
        await post(`/bills/${bill.id}/post`, { version: saved.version });
        toastOk(`${bill.number} posted`);
      }
      await queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="lg">
      <PageHeader title={`${bill.kind === "FREIGHT_IN" ? "Freight-in" : "Freight-out"} ${bill.number}`} subtitle={bill.kind === "FREIGHT_IN" ? "Added to the cost of the goods it brought in (GAAP: freight-in is part of inventory cost)." : "Shipping to customers: an expense, not inventory."} action={<StatusBadge status="DRAFT" />} />
      <Card withBorder className="section">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label="Carrier" data={(carriers.data ?? []).map((v) => ({ value: String(v.id), label: v.name }))} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} searchable />
          <TextInput label="Carrier's invoice number" value={form.invoice} onChange={(e) => setForm({ ...form, invoice: e.currentTarget.value })} />
          <TextInput label="Amount $" value={form.amount} inputMode="decimal" onChange={(e) => setForm({ ...form, amount: e.currentTarget.value })} />
          <TextInput type="date" label="Bill date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.currentTarget.value })} />
        </SimpleGrid>
        {bill.kind === "FREIGHT_IN" ? (
          <Stack mt="md">
            <MultiSelect label="Orders this freight brought in" data={(orders.data ?? []).filter((o) => o.lifecycle !== "CANCELED").map((o) => ({ value: String(o.id), label: `${o.number} · ${o.vendor?.name ?? "vendor not set"}` }))} value={form.targets} onChange={(targets) => setForm({ ...form, targets })} searchable />
            <SegmentedControl value={form.basis} onChange={(v) => setForm({ ...form, basis: v as AllocationBasis })} data={[{ value: "VALUE", label: "Spread by line value" }, { value: "QTY", label: "Spread by units" }]} />
          </Stack>
        ) : null}
      </Card>
      {bill.kind === "FREIGHT_IN" && preview.data?.length ? (
        <Card withBorder className="section">
          <Text fw={600} mb="xs">
            Spread (as last saved)
          </Text>
          {preview.data.map((p) => (
            <Group key={p.poLineId} justify="space-between">
              <Text>{p.item.name}</Text>
              <Money cents={p.amountCents} />
            </Group>
          ))}
          <Text size="sm" c="dimmed" mt="xs">
            Each share goes to the units not yet arrived, the units still on the shelf (their average cost rises), or — for units already gone — cost of goods sold.
          </Text>
        </Card>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={() => run("save")} loading={busy}>
          Save
        </Button>
        <HoldToConfirmButton onConfirm={() => run("post")} busy={busy} disabled={!form.vendorId || !form.invoice || cents(form.amount) <= 0 || (bill.kind === "FREIGHT_IN" && form.targets.length === 0)} confirmed="Posting…">
          Hold to post
        </HoldToConfirmButton>
      </Group>
    </Stack>
  );
}

export function NewFreightBill() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const carriers = useQuery({ queryKey: ["vendors", "CARRIER"], queryFn: () => get<Vendor[]>("/vendors?kind=CARRIER") });
  const orders = useQuery({ queryKey: ["orders", "ALL"], queryFn: () => get<PurchaseOrder[]>("/purchase-orders?lifecycle=ALL") });
  const [kind, setKind] = useState("FREIGHT_IN");
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  // Opened from a bill, the order is already known; from the Bills desk, pick it here.
  const [targets, setTargets] = useState<string[]>(params.get("po") ? [params.get("po")!] : []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const form = useBlurErrors();
  const inbound = kind === "FREIGHT_IN";
  const amountCents = cents(amount);
  const valid = Boolean(vendorId) && amountCents > 0 && (!inbound || targets.length > 0);
  const create = async () => {
    if (busy || !form.submit(valid)) return;
    setBusy(true);
    setFailed("");
    try {
      const bill = await post<Bill>("/freight-bills", { kind, vendorId: Number(vendorId), amountCents: cents(amount), targetPoIds: inbound ? targets.map(Number) : [] });
      navigate(`/bills/${bill.id}`);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); void create(); }}>
    <Stack maw={520}>
      <PageHeader title="Freight bill" subtitle="A carrier's invoice for shipping." />
      <SegmentedControl value={kind} onChange={setKind} data={[{ value: "FREIGHT_IN", label: "Bringing stock in" }, { value: "FREIGHT_OUT", label: "Shipping to customers" }]} />
      <Select
        label="Carrier" withAsterisk
        placeholder={carriers.isLoading ? "Loading…" : "Choose a carrier"}
        disabled={carriers.isLoading}
        data={(carriers.data ?? []).map((v) => ({ value: String(v.id), label: v.name }))}
        value={vendorId} onChange={setVendorId} searchable
        description="Carriers are vendors of the carrier kind (Settings → Vendors)."
        onBlur={form.blur("carrier")}
        error={form.show("carrier", vendorId ? null : "Choose the carrier that sent this invoice.")}
      />
      <TextInput
        label="Amount $" withAsterisk value={amount} onChange={(e) => setAmount(e.currentTarget.value)} inputMode="decimal"
        onBlur={form.blur("amount")}
        error={form.show("amount", amountCents > 0 ? null : "Enter an amount above $0.00.")}
      />
      {inbound ? (
        <MultiSelect
          label="Orders this freight brought in" withAsterisk
          description="Its cost is spread over these orders' items as landed cost."
          placeholder={orders.isLoading ? "Loading…" : targets.length ? undefined : "Pick one or more purchase orders"}
          disabled={orders.isLoading}
          data={(orders.data ?? []).filter((o) => o.lifecycle !== "CANCELED").map((o) => ({ value: String(o.id), label: `${o.number} · ${o.vendor?.name ?? "vendor not set"}` }))}
          value={targets}
          onChange={setTargets}
          searchable
          nothingFoundMessage="No purchase orders yet: receive a delivery first."
          onBlur={form.blur("orders")}
          error={form.show("orders", targets.length > 0 ? null : "Choose the orders this freight brought in.")}
        />
      ) : null}
      {failed ? (
        <Alert role="alert" color="orange" title="The freight bill was not created" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
          {failed} Nothing was saved; fix it and press Continue again.
        </Alert>
      ) : null}
      <Button type="submit" loading={busy}>
        Continue
      </Button>
    </Stack>
    </form>
  );
}

/** A posted bill: what it cost, what's paid, what's open — and the actions that follow. */
function PostedBill({ bill }: { bill: FullBill }) {
  const queryClient = useQueryClient();
  const journal = useQuery({ queryKey: ["journal", bill.id], queryFn: () => get<{ id: number; number: string; event: string; date: string; lines: { side: string; amountCents: number; account: { code: string; name: string } }[] }[]>(`/journal?sourceType=BILL&sourceId=${bill.id}`) });
  const [modal, setModal] = useState<"pay" | "refund" | "credit" | null>(null);
  const [voiding, setVoiding] = useState(false);
  const open = bill.openCents ?? 0;
  const toReceive = [...new Map(bill.lines.flatMap((l) => (l.poLine ? [[l.poLine.id, l.poLine] as const] : []))).values()].reduce((s, p) => s + Math.max(0, p.qtyOrdered - p.qtyReceived), 0);
  const refresh = () => queryClient.invalidateQueries();
  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toastOk(message);
      setModal(null);
      refresh();
      return null;
    } catch (error) {
      toastErr(error);
      return error;
    }
  };
  return (
    <Stack gap="lg">
      <PageHeader
        back={{ to: "/bills", label: "Bills" }}
        title={bill.number}
        subtitle={`${bill.vendor?.name ?? ""} · invoice ${bill.vendorInvoiceNumber ?? "—"} · billed ${formatDate(bill.billDate)} · due ${formatDate(bill.dueDate)}`}
        action={<StatusBadge status={bill.status} />}
      />
      <div className="detail-grid">
      <aside className="detail-aside" aria-label="Bill summary and actions">
      <SimpleGrid cols={2} spacing="md">
        <Stat label="Total" value={usd(bill.totalCents)} />
        <Stat label="Paid" value={usd(bill.paidCents)} />
        <Stat label="Credited" value={usd(bill.creditedCents)} />
        <Stat label={open < 0 ? "Vendor owes us" : "Open"} value={<span className={open === 0 && bill.status === "POSTED" ? "rule-in" : undefined}>{usd(Math.abs(open))}</span>} signal={open === 0 && bill.status === "POSTED"} />
      </SimpleGrid>
      {bill.status === "POSTED" && bill.kind === "INVENTORY" && bill.poId && toReceive > 0 ? (
        <Alert color="lime" title={`${plural(toReceive, "unit")} from this bill ${toReceive === 1 ? "hasn't" : "haven't"} arrived yet`}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">When the delivery shows up, receive it against {bill.po?.number ?? "its order"}. Stock goes on hand at the billed cost.</Text>
            <Button component={Link} to={`/receive?po=${bill.poId}`} variant="default">
              Receive these
            </Button>
          </Group>
        </Alert>
      ) : null}
      {bill.status === "POSTED" ? (
        <Group>
          {open > 0 ? <Button onClick={() => setModal("pay")}>Record payment</Button> : null}
          {open < 0 ? <Button onClick={() => setModal("refund")}>Record vendor refund</Button> : null}
          {bill.kind === "INVENTORY" ? (
            <Button variant="light" onClick={() => setModal("credit")}>
              Vendor credit
            </Button>
          ) : null}
          <Button variant="subtle" color="red" onClick={() => setVoiding((v) => !v)}>
            Void…
          </Button>
        </Group>
      ) : null}
      {voiding && bill.status === "POSTED" ? (
        <Card withBorder className="section">
          <Text size="sm" mb="sm" maw="68ch">
            Voiding reverses the bill's entry. Stock it brought in goes back to "awaiting a bill" and a fresh draft is made for it. Not possible once it's paid, credited, or its stock has been used — use a vendor credit then.
          </Text>
          <HoldToConfirmButton tone="danger" duration={1400} onConfirm={() => act(() => post(`/bills/${bill.id}/void`), `${bill.number} voided`)} confirmed="Voiding…">
            Hold to void {bill.number}
          </HoldToConfirmButton>
        </Card>
      ) : null}

      </aside>
      <div className="detail-main">
      <Card withBorder className="section">
        <Title order={3} mb="sm">
          Lines
        </Title>
        <Table.ScrollContainer minWidth={520}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Unit</Table.Th>
                <Table.Th ta="right">Freight</Table.Th>
                <Table.Th ta="right">Landed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {bill.lines.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>{l.item?.name ?? l.description}</Table.Td>
                  <Table.Td ta="right">{l.qty || ""}</Table.Td>
                  <Table.Td ta="right">{l.qty ? usd(l.unitCostCents) : ""}</Table.Td>
                  <Table.Td ta="right">{l.qty ? usd(l.freightCents) : ""}</Table.Td>
                  <Table.Td ta="right">{usd(l.qty ? l.landedCents : l.amountCents)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      {bill.status === "POSTED" ? <MatchPanel match={bill.match} /> : null}

      {bill.payments.length || bill.credits.length ? (
        <Card withBorder className="section">
          <Title order={3} mb="sm">
            Payments and credits
          </Title>
          <Table.ScrollContainer minWidth={560}>
            <Table withRowBorders={false} verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Transaction</Table.Th>
                  <Table.Th ta="right">Quantity</Table.Th>
                  <Table.Th ta="right">Unit cost</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {bill.payments.map((p) => (
                  <Table.Tr key={p.id}>
                    <Table.Td td={p.status === "VOID" ? "line-through" : undefined}>
                      {p.number} · {p.direction === "OUT" ? "paid" : "refund received"} {formatDate(p.paidAt)} · {p.method.toLowerCase()} · {p.actor}
                    </Table.Td>
                    <Table.Td ta="right" c="dimmed">
                      {"\u2014"}
                    </Table.Td>
                    <Table.Td ta="right" c="dimmed">
                      {"\u2014"}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Money cents={p.amountCents} />
                    </Table.Td>
                    <Table.Td ta="right">
                      {p.status === "POSTED" ? (
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => act(() => post(`/payments/${p.id}/void`), `${p.number} voided`)}>
                          Void
                        </Button>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {bill.credits.map((c) => {
                  const returned = c.lines.filter((l) => l.qty > 0);
                  const heading = (
                    <>
                      {c.number} · {c.kind === "RETURN" ? "return" : "price discount"} {formatDate(c.date)} · {c.actor}
                      {c.memo ? ` · ${c.memo}` : ""}
                    </>
                  );
                  if (returned.length === 0) {
                    return (
                      <Table.Tr key={c.id}>
                        <Table.Td>{heading}</Table.Td>
                        <Table.Td ta="right" c="dimmed">
                          {"\u2014"}
                        </Table.Td>
                        <Table.Td ta="right" c="dimmed">
                          {"\u2014"}
                        </Table.Td>
                        <Table.Td ta="right">
                          <Money cents={c.totalCents} />
                        </Table.Td>
                        <Table.Td />
                      </Table.Tr>
                    );
                  }
                  return returned.map((l, i) => (
                    <Table.Tr key={`${c.id}-${l.id}`}>
                      <Table.Td>
                        {i === 0 ? heading : null}
                        <Text size="xs" c="dimmed">
                          {bill.lines.find((bl) => bl.itemId === l.itemId)?.item?.name ?? `Item ${l.itemId}`}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{l.qty}</Table.Td>
                      <Table.Td ta="right">{usd(Math.round(l.amountCents / l.qty))}</Table.Td>
                      <Table.Td ta="right">
                        <Money cents={l.amountCents} />
                      </Table.Td>
                      <Table.Td />
                    </Table.Tr>
                  ));
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      ) : null}

      <Card withBorder className="section">
        <Title order={3} mb="sm">
          In the ledger
        </Title>
        {(journal.data ?? []).map((e) => (
          <Stack key={e.id} gap={2} mb="sm">
            <Text size="sm" c="dimmed">
              {e.number} · {formatDate(e.date)}
            </Text>
            {e.lines.map((l, i) => (
              <Group key={i} justify="space-between" pl={l.side === "CREDIT" ? "lg" : 0}>
                <Text size="sm">
                  {l.side === "DEBIT" ? "Dr" : "Cr"} {l.account.code} {l.account.name}
                </Text>
                <Text size="sm">
                  <Money cents={l.amountCents} />
                </Text>
              </Group>
            ))}
          </Stack>
        ))}
      </Card>

      </div>
      </div>

      <PayModal opened={modal === "pay" || modal === "refund"} refund={modal === "refund"} max={Math.abs(open)} onClose={() => setModal(null)} onSave={(body) => act(() => post(`/bills/${bill.id}/${modal === "refund" ? "refunds" : "payments"}`, body), modal === "refund" ? "Refund recorded" : "Payment recorded")} />
      <CreditModal opened={modal === "credit"} bill={bill} onClose={() => setModal(null)} onSave={(body) => act(() => post(`/bills/${bill.id}/credits`, body), "Vendor credit posted")} />
    </Stack>
  );
}

function PayModal({ opened, refund, max, onClose, onSave }: { opened: boolean; refund: boolean; max: number; onClose: () => void; onSave: (body: unknown) => Promise<unknown> }) {
  const [amount, setAmount] = useState(dollars(max));
  const [method, setMethod] = useState<string | null>("ACH");
  const [paidAt, setPaidAt] = useState(toInputDate(new Date()));
  const [actionId, setActionId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState("");
  const errors = useBlurErrors();
  const submitting = useRef(false);
  const amountCents = cents(amount);
  const amountOk = amountCents > 0 && amountCents <= max;
  const valid = amountOk && Boolean(method) && Boolean(paidAt);
  useEffect(() => {
    if (!opened) return;
    setActionId(crypto.randomUUID());
    setFailed("");
    errors.reset();
  }, [opened]);
  useEffect(() => setAmount(dollars(max)), [max, opened]);
  const save = async () => {
    if (submitting.current || !errors.submit(valid)) return;
    submitting.current = true;
    setPending(true);
    setFailed("");
    try {
      const error = await onSave({ actionId, amountCents: cents(amount), method, paidAt });
      if (error) setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const amountError = refund
    ? `Enter an amount above $0.00, up to the ${usd(max)} the vendor owes.`
    : `Enter an amount above $0.00, up to the ${usd(max)} still owed.`;
  return (
    <Modal opened={opened} onClose={() => { if (!submitting.current) onClose(); }} title={refund ? "Vendor refund received" : "Pay this bill"}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Stack>
        <TextInput
          label="Amount $" withAsterisk disabled={pending} value={amount} onChange={(e) => setAmount(e.currentTarget.value)} inputMode="decimal"
          description={`Up to ${usd(max)}`}
          onBlur={errors.blur("amount")}
          error={errors.show("amount", amountOk ? null : amountError)}
        />
        <Select
          label="Method" withAsterisk disabled={pending} allowDeselect={false}
          data={["ACH", "WIRE", "CHECK", "CARD", "BANK", "CASH"]} value={method} onChange={setMethod}
          onBlur={errors.blur("method")}
          error={errors.show("method", method ? null : refund ? "Choose how the refund arrived." : "Choose how this was paid.")}
        />
        <TextInput
          type="date" label="Date" withAsterisk disabled={pending} value={paidAt} onChange={(e) => setPaidAt(e.currentTarget.value)}
          onBlur={errors.blur("date")}
          error={errors.show("date", paidAt ? null : refund ? "Enter the date this refund arrived." : "Enter the date this was paid.")}
        />
        {failed ? (
          <Alert role="alert" color="orange" title={refund ? "The refund was not recorded" : "The payment was not recorded"} styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
            {failed} Nothing was saved; fix it and press {refund ? "Record refund" : "Record payment"} again.
          </Alert>
        ) : null}
        <Button type="submit" loading={pending}>
          {refund ? "Record refund" : "Record payment"}
        </Button>
      </Stack>
      </form>
    </Modal>
  );
}

function CreditModal({ opened, bill, onClose, onSave }: { opened: boolean; bill: FullBill; onClose: () => void; onSave: (body: unknown) => Promise<unknown> }) {
  const [kind, setKind] = useState("RETURN");
  const [lineId, setLineId] = useState<string | null>(bill.lines[0] ? String(bill.lines[0].id) : null);
  const [qty, setQty] = useState(1);
  const [amount, setAmount] = useState("");
  const [received, setReceived] = useState(true);
  const [serials, setSerials] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const errors = useBlurErrors();
  const submitting = useRef(false);
  const line = bill.lines.find((l) => String(l.id) === lineId);
  const suggested = line && line.qty ? Math.round((line.landedCents * qty) / line.qty) : 0;
  const amountOk = kind !== "PRICE_ALLOWANCE" || cents(amount) > 0;
  const valid = Boolean(lineId) && amountOk;
  useEffect(() => {
    if (!opened) return;
    setFailed("");
    errors.reset();
  }, [opened]);
  const save = async () => {
    if (submitting.current || !errors.submit(valid)) return;
    submitting.current = true;
    setBusy(true);
    setFailed("");
    try {
      const error = await onSave({
        kind,
        lines: [
          {
            billLineId: Number(lineId),
            qty: kind === "RETURN" ? qty : 0,
            amountCents: amount ? cents(amount) : kind === "RETURN" ? undefined : 0,
            received,
            serials: serials ? serials.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          },
        ],
      });
      if (error) setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={() => { if (!submitting.current) onClose(); }} title="Vendor credit">
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Stack>
        <SegmentedControl value={kind} onChange={setKind} data={[{ value: "RETURN", label: "Return units" }, { value: "PRICE_ALLOWANCE", label: "Price discount" }]} />
        <Select
          label="Line" withAsterisk disabled={busy}
          data={bill.lines.map((l) => ({ value: String(l.id), label: `${l.item?.name} · ${l.qty} @ ${usd(l.unitCostCents)}` }))}
          value={lineId} onChange={setLineId}
          onBlur={errors.blur("line")}
          error={errors.show("line", lineId ? null : "Choose the line this credit applies to.")}
        />
        {kind === "RETURN" ? (
          <>
            <NumberInput label="Units" withAsterisk disabled={busy} value={qty} onChange={(v) => setQty(Number(v) || 1)} min={1} hideControls inputMode="numeric" />
            <Switch checked={received} disabled={busy} onChange={(e) => setReceived(e.currentTarget.checked)} label={received ? "Units we have, going back to the vendor" : "Billed units that never arrived"} />
            {received && line?.item?.trackingMode === "SERIAL" ? <TextInput label="Serials going back" description="Comma-separated" disabled={busy} value={serials} onChange={(e) => setSerials(e.currentTarget.value)} /> : null}
          </>
        ) : null}
        <TextInput
          label="Credit amount $" withAsterisk={kind === "PRICE_ALLOWANCE"} disabled={busy}
          value={amount} placeholder={kind === "RETURN" ? dollars(suggested) : ""} onChange={(e) => setAmount(e.currentTarget.value)} inputMode="decimal"
          description={kind === "RETURN" ? "Blank = what those units cost on this bill" : "How much the vendor took off"}
          onBlur={errors.blur("amount")}
          error={errors.show("amount", amountOk ? null : "Enter the discount, above $0.00.")}
        />
        {failed ? (
          <Alert role="alert" color="orange" title="The credit was not posted" styles={{ root: { background: "var(--warn-bg)", border: "1px solid transparent" }, title: { color: "var(--warn-fg)" } }}>
            {failed} Nothing was saved; fix it and press Post credit again.
          </Alert>
        ) : null}
        <Button type="submit" loading={busy}>
          Post credit
        </Button>
      </Stack>
      </form>
    </Modal>
  );
}
