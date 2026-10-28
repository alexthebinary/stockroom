import { EVENTS, type EventType } from "@pi/domain";
import { Alert, Button, Card, Group, SegmentedControl, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router-dom";
import { plural, formatDate, Loading, Money, PageHeader, usd } from "../../components/ui";
import { get } from "../../lib/api";
import type { JournalEntry } from "../../lib/types";

type Books = { sound: boolean; problems: string[]; figures: Record<string, number> };
type Tb = { rows: { id: number; code: string; name: string; isHeader: boolean; parentId: number | null; debitCents: number; creditCents: number }[]; totalDebitCents: number; totalCreditCents: number };
type Valuation = { rows: { itemId: number; sku: string; name: string; onHand: number; held: number; valueCents: number; averageCents: number; glCents: number; varianceCents: number }[]; totalValueCents: number; totalGlCents: number };
type ToReceive = {
  orders: { poId: number; poNumber: string; billingStatus: string; vendor: { name: string } | null; warehouse: { name: string } | null; days: number; units: number; valueCents: number; lines: { lineId: number; item: { name: string; sku: string }; ordered: number; received: number; outstanding: number; billed: boolean }[] }[];
  totalUnits: number;
  totalValueCents: number;
};
type Held = { poId: number; poNumber: string; vendor: { name: string } | null; item: { name: string }; qtyHeld: number; estimateCents: number; receivedAt: string; days: number }[];
type InventoryMovement = { rows: { id: number; itemId: number; transactionDate: string; sku: string; name: string; brand: string | null; category: string | null; inboundQty: number; outboundQty: number; endingBalance: number }[] };

const REPORT_TABS = {
  books: { label: "Books check", component: BooksCheck },
  tb: { label: "Trial balance", component: TrialBalance },
  journal: { label: "Journal entries", component: Journal },
  held: { label: "Awaiting bill", component: HeldStock },
  toReceive: { label: "To receive", component: ToReceiveReport },
  stock: { label: "Stock value", component: StockValue },
  movement: { label: "Inventory movement", component: InventoryMovementReport },
};

type ReportTab = keyof typeof REPORT_TABS;
const REPORT_CATEGORIES: { value: string; label: string; tabs: ReportTab[] }[] = [
  { value: "accounting", label: "Accounting", tabs: ["books", "tb", "journal"] },
  { value: "sales", label: "Sales", tabs: [] },
  { value: "purchases", label: "Purchases", tabs: ["held", "toReceive"] },
  { value: "inventory", label: "Inventory", tabs: ["stock", "movement"] },
];

export function Reports() {
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const category = REPORT_CATEGORIES.find((c) => c.value === params.get("cat"))
    ?? REPORT_CATEGORIES.find((c) => c.tabs.some((tab) => tab === requestedTab))
    ?? REPORT_CATEGORIES[0]!;
  const tab = category.tabs.find((value) => value === requestedTab) ?? category.tabs[0] ?? null;

  const selectReport = (cat: string, selectedTab: string | null) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("cat", cat);
      if (selectedTab) next.set("tab", selectedTab);
      else next.delete("tab");
      return next;
    });
  };

  return (
    <>
      <PageHeader title="Reports" />
      <SegmentedControl
        mb="md"
        aria-label="Report category"
        value={category.value}
        data={REPORT_CATEGORIES.map(({ value, label }) => ({ value, label }))}
        onChange={(value) => {
          const next = REPORT_CATEGORIES.find((c) => c.value === value)!;
          selectReport(next.value, next.tabs[0] ?? null);
        }}
      />
      {category.value === "sales" ? (
        <Text c="dimmed">Sales reports arrive with sales orders.</Text>
      ) : (
        <Tabs value={tab} onChange={(value) => selectReport(category.value, value)}>
          <Tabs.List mb="md">
            {category.tabs.map((value) => <Tabs.Tab key={value} value={value}>{REPORT_TABS[value].label}</Tabs.Tab>)}
          </Tabs.List>
          {category.tabs.map((value) => {
            const Report = REPORT_TABS[value].component;
            return <Tabs.Panel key={value} value={value}><Report /></Tabs.Panel>;
          })}
        </Tabs>
      )}
    </>
  );
}

function BooksCheck() {
  const books = useQuery({ queryKey: ["books"], queryFn: () => get<Books>("/books/check") });
  if (!books.data) return <Loading />;
  const f = books.data.figures;
  const checks = [
    ["Debits equal credits", f.debitsCents === f.creditsCents, `${usd(f.debitsCents)} = ${usd(f.creditsCents)}`],
    ["Inventory on hand equals stock at average cost", f.onHandGlCents === f.onHandPoolCents, `${usd(f.onHandGlCents)} = ${usd(f.onHandPoolCents)}`],
    ["Inventory in transit equals billed stock not yet arrived", f.inboundGlCents === f.inboundOpenCents, `${usd(f.inboundGlCents)} = ${usd(f.inboundOpenCents)}`],
    ["Accounts Payable equals open bills", f.payableGlCents === f.payableOpenCents, `${usd(f.payableGlCents)} = ${usd(f.payableOpenCents)}`],
  ] as const;
  return (
    <Stack>
      <Text c="dimmed">Each line compares two records written by different code, item by item and vendor by vendor. All four agreeing is what lets you trust every other number.</Text>
      {checks.map(([label, ok, detail]) => (
        <Card key={label} withBorder padding="sm">
          <Group wrap="nowrap">
            {ok ? <IconCircleCheck color="var(--mantine-color-lime-7)" /> : <IconAlertTriangle color="var(--mantine-color-orange-7)" />}
            <div>
              <Text fw={500}>{label}</Text>
              <Text size="sm" c="dimmed">
                {detail}
              </Text>
            </div>
          </Group>
        </Card>
      ))}
      {books.data.problems.length ? (
        <Alert color="orange" title="Details">
          {books.data.problems.map((p) => (
            <Text key={p} size="sm">
              {p}
            </Text>
          ))}
        </Alert>
      ) : null}
    </Stack>
  );
}

function TrialBalance() {
  const tb = useQuery({ queryKey: ["tb"], queryFn: () => get<Tb>("/reports/trial-balance") });
  if (!tb.data) return <Loading />;
  return (
    <Table.ScrollContainer minWidth={480}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Account</Table.Th>
            <Table.Th ta="right">Debit</Table.Th>
            <Table.Th ta="right">Credit</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tb.data.rows
            .filter((r) => r.debitCents || r.creditCents || r.isHeader)
            .map((r) => (
              <Table.Tr key={r.id} fw={r.isHeader ? 600 : undefined}>
                <Table.Td pl={r.parentId ? 28 : undefined}>
                  {r.code} {r.name}
                </Table.Td>
                <Table.Td ta="right">{r.debitCents ? <Money cents={r.debitCents} /> : ""}</Table.Td>
                <Table.Td ta="right">{r.creditCents ? <Money cents={r.creditCents} /> : ""}</Table.Td>
              </Table.Tr>
            ))}
          <Table.Tr fw={700}>
            <Table.Td>Total (posting accounts)</Table.Td>
            <Table.Td ta="right">
              <Money cents={tb.data.totalDebitCents} />
            </Table.Td>
            <Table.Td ta="right">
              <Money cents={tb.data.totalCreditCents} />
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

const PAGE = 50;
/** Inventory is one account (1200); its lines say which part they move. */
const INVENTORY_PART: Record<string, string> = { inventoryOnHand: "on hand", inventoryInbound: "in transit" };

/** The general journal: every entry, newest first, each with its debits and credits. */
function Journal() {
  const [event, setEvent] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const journal = useQuery({
    queryKey: ["journal", event, pages],
    queryFn: () => get<JournalEntry[]>(`/journal?take=${PAGE * pages}${event ? `&event=${event}` : ""}`),
    placeholderData: keepPreviousData,
  });
  const entries = journal.data ?? [];
  const lines = entries.flatMap((e) => e.lines);
  const total = (side: "DEBIT" | "CREDIT") => lines.filter((l) => l.side === side).reduce((s, l) => s + l.amountCents, 0);
  return (
    <Stack>
      <Group justify="space-between" align="flex-end">
        <Select
          aria-label="Transaction type"
          placeholder="All transaction types"
          data={Object.entries(EVENTS).map(([value, e]) => ({ value, label: e.label }))}
          value={event}
          onChange={(v) => {
            setEvent(v);
            setPages(1);
          }}
          clearable
          w={280}
        />
        <Text size="sm" c="dimmed">
          {plural(entries.length, "entry", "entries")}, newest first
        </Text>
      </Group>
      {journal.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <div className="ruled-empty">{event ? "No entries of this type yet." : "Nothing is posted yet. Entries appear here as bills, receipts and payments post."}</div>
      ) : (
        <Table.ScrollContainer minWidth={720}>
          <Table withRowBorders={false} verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Entry</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Account</Table.Th>
                <Table.Th ta="right">Debit</Table.Th>
                <Table.Th ta="right">Credit</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.flatMap((e) =>
                e.lines.map((l, i) => (
                  <Table.Tr key={l.id} style={i === 0 ? { borderTop: "1px solid var(--line)" } : undefined}>
                    <Table.Td style={{ verticalAlign: "top" }}>
                      {i === 0 ? (
                        <>
                          <Text size="sm" fw={600}>
                            {e.number}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {formatDate(e.date)} · {e.actor}
                          </Text>
                        </>
                      ) : null}
                    </Table.Td>
                    <Table.Td style={{ verticalAlign: "top" }}>
                      {i === 0 ? (
                        <>
                          <Text size="sm">{(e.reverses ? `Reversal of ${e.reverses.number}: ` : "") + (EVENTS[e.event as EventType]?.label ?? e.event)}</Text>
                          {e.memo ? (
                            <Text size="xs" c="dimmed">
                              {e.memo}
                            </Text>
                          ) : null}
                        </>
                      ) : null}
                    </Table.Td>
                    <Table.Td pl={l.side === "CREDIT" ? 32 : undefined}>
                      {l.account.code} {l.account.name}
                      {INVENTORY_PART[l.role] ? (
                        <Text span size="xs" c="dimmed">
                          {" "}
                          · {INVENTORY_PART[l.role]}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td ta="right">{l.side === "DEBIT" ? <Money cents={l.amountCents} /> : ""}</Table.Td>
                    <Table.Td ta="right">{l.side === "CREDIT" ? <Money cents={l.amountCents} /> : ""}</Table.Td>
                  </Table.Tr>
                )),
              )}
              <Table.Tr fw={700} style={{ borderTop: "1px solid var(--ink)" }}>
                <Table.Td colSpan={3}>Total shown</Table.Td>
                <Table.Td ta="right">
                  <Money cents={total("DEBIT")} />
                </Table.Td>
                <Table.Td ta="right">
                  <Money cents={total("CREDIT")} />
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {entries.length === PAGE * pages ? (
        <Button variant="subtle" w="fit-content" onClick={() => setPages(pages + 1)} loading={journal.isFetching}>
          Show {PAGE} more
        </Button>
      ) : null}
    </Stack>
  );
}

function InventoryMovementReport() {
  const [range, setRange] = useState(() => {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 29);
    return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  });
  const validRange = Boolean(range.from && range.to && range.from <= range.to);
  const movement = useQuery({
    queryKey: ["inventory-movement", range.from, range.to],
    queryFn: () => get<InventoryMovement>(`/reports/inventory-movement?${new URLSearchParams(range)}`),
    enabled: validRange,
  });
  return (
    <Stack>
      <Group align="flex-end">
        <TextInput type="date" label="Start date" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.currentTarget.value })} />
        <TextInput type="date" label="End date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.currentTarget.value })} />
      </Group>
      <Text size="sm" c="dimmed">On-hand stock across all warehouses, oldest first. Dates use UTC; ending balance is per item after each movement.</Text>
      {!validRange ? (
        <Text c="dimmed">Choose a start and end date, with the end on or after the start.</Text>
      ) : movement.isError ? (
        <Alert color="orange" title="Could not load inventory movements">{movement.error.message}</Alert>
      ) : !movement.data ? (
        <Loading />
      ) : movement.data.rows.length === 0 ? (
        <Text c="dimmed">No inventory movements in this date range.</Text>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Transaction date</Table.Th>
                <Table.Th>Item SKU</Table.Th>
                <Table.Th>Item name</Table.Th>
                <Table.Th>Brand</Table.Th>
                <Table.Th>Category</Table.Th>
                <Table.Th ta="right">Inbound qty</Table.Th>
                <Table.Th ta="right">Outbound qty</Table.Th>
                <Table.Th ta="right">Ending balance</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {movement.data.rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>{row.transactionDate.slice(0, 10)}</Table.Td>
                  <Table.Td>{row.sku}</Table.Td>
                  <Table.Td>{row.name}</Table.Td>
                  <Table.Td>{row.brand ?? "—"}</Table.Td>
                  <Table.Td>{row.category ?? "—"}</Table.Td>
                  <Table.Td ta="right">{row.inboundQty}</Table.Td>
                  <Table.Td ta="right">{row.outboundQty}</Table.Td>
                  <Table.Td ta="right">{row.endingBalance}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function StockValue() {
  const v = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  if (!v.data) return <Loading />;
  return (
    <Table.ScrollContainer minWidth={620}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Item</Table.Th>
            <Table.Th ta="right">On hand</Table.Th>
            <Table.Th ta="right">Average</Table.Th>
            <Table.Th ta="right">Value</Table.Th>
            <Table.Th ta="right">Ledger</Table.Th>
            <Table.Th ta="right">Awaiting bill</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {v.data.rows.map((r) => (
            <Table.Tr key={r.itemId}>
              <Table.Td>
                {r.sku} · {r.name}
              </Table.Td>
              <Table.Td ta="right">{r.onHand}</Table.Td>
              <Table.Td ta="right">{usd(Math.round(r.averageCents))}</Table.Td>
              <Table.Td ta="right">
                <Money cents={r.valueCents} />
              </Table.Td>
              <Table.Td ta="right" c={r.varianceCents ? "orange" : undefined}>
                <Money cents={r.glCents} />
              </Table.Td>
              <Table.Td ta="right">{r.held || ""}</Table.Td>
            </Table.Tr>
          ))}
          <Table.Tr fw={700}>
            <Table.Td>Total</Table.Td>
            <Table.Td />
            <Table.Td />
            <Table.Td ta="right">
              <Money cents={v.data.totalValueCents} />
            </Table.Td>
            <Table.Td ta="right">
              <Money cents={v.data.totalGlCents} />
            </Table.Td>
            <Table.Td />
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function HeldStock() {
  const held = useQuery({ queryKey: ["held"], queryFn: () => get<Held>("/reports/held") });
  if (!held.data) return <Loading />;
  if (held.data.length === 0) return <Text c="dimmed">Nothing is waiting for a bill.</Text>;
  return (
    <Stack gap="xs">
      <Text c="dimmed">Received at the dock, counted, not yet sellable or valued. Oldest first.</Text>
      {held.data.map((h, i) => (
        <Card key={i} withBorder padding="sm" component={Link} to={`/orders/${h.poId}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text fw={600}>
                {h.qtyHeld} × {h.item.name}
              </Text>
              <Text size="sm" c="dimmed">
                {h.poNumber} · {h.vendor?.name ?? "vendor not set"} · since {formatDate(h.receivedAt)}
              </Text>
            </div>
            <Text c={h.days > 7 ? "orange" : undefined} fw={600}>
              {plural(h.days, "day")}
            </Text>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

/** Ordered, not yet at the dock. Each order opens Receive with that order picked. */
function ToReceiveReport() {
  const data = useQuery({ queryKey: ["to-receive"], queryFn: () => get<ToReceive>("/reports/to-receive") });
  if (!data.data) return <Loading />;
  if (data.data.orders.length === 0) return <Text c="dimmed">Everything ordered has arrived.</Text>;
  return (
    <Stack gap="xs">
      <Text c="dimmed">
        {plural(data.data.totalUnits, "unit")} on order, about {usd(data.data.totalValueCents)} at order cost. Oldest order first. Tap one to receive it.
      </Text>
      {data.data.orders.map((o) => (
        <Card key={o.poId} withBorder padding="sm" component={Link} to={`/receive?po=${o.poId}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div>
              <Text fw={600}>
                {o.poNumber} · {o.vendor?.name ?? "vendor not set"}
              </Text>
              {o.lines.map((l) => (
                <Text key={l.lineId} size="sm" c="dimmed">
                  {l.outstanding} × {l.item.name}
                  {l.received ? ` (${l.received} of ${l.ordered} already in)` : ""}
                </Text>
              ))}
              <Text size="xs" c="dimmed">
                {o.warehouse?.name ?? ""} · {o.billingStatus === "NOT_BILLED" ? "not billed yet" : o.billingStatus === "BILLED" ? "billed, owed to the vendor" : o.billingStatus.replace("_", " ").toLowerCase()}
              </Text>
            </div>
            <Text fw={600} c={o.days > 14 ? "orange" : undefined} style={{ whiteSpace: "nowrap" }}>
              {plural(o.days, "day")} ago
            </Text>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
