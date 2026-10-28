import { EVENTS, type EventType } from "@pi/domain";
import { Alert, Button, Card, Checkbox, Group, SegmentedControl, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
  orders: { poId: number; poNumber: string; billingStatus: string; vendor: { name: string } | null; warehouse: { id: number; code: string; name: string } | null; days: number; units: number; valueCents: number; lines: { lineId: number; item: { name: string; sku: string }; ordered: number; received: number; outstanding: number; billed: boolean }[] }[];
  totalUnits: number;
  totalValueCents: number;
};
type Held = { poId: number; poNumber: string; vendor: { name: string } | null; item: { name: string; sku: string }; qtyHeld: number; estimateCents: number; receivedAt: string; days: number }[];
type InventoryMovement = { rows: { id: number; itemId: number; transactionDate: string; sku: string; name: string; brand: string | null; category: string | null; inboundQty: number; outboundQty: number; endingBalance: number }[] };

/** Each report owns its URL keys; switching tabs and browser navigation preserve filters. */
function useReportFilters<T extends Record<string, string>>(prefix: string, defaults: T) {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, params.get(`${prefix}_${key}`) ?? fallback])) as T;
  const set = (key: keyof T & string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (value === defaults[key]) next.delete(`${prefix}_${key}`);
    else next.set(`${prefix}_${key}`, value);
    return next;
  }, { replace: true });
  const clear = () => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const key of Object.keys(defaults)) next.delete(`${prefix}_${key}`);
    return next;
  }, { replace: true });
  return { values, set, clear, active: Object.keys(defaults).some((key) => values[key] !== defaults[key]) };
}

function matches(query: string, ...fields: (string | null | undefined)[]) {
  const needle = query.trim().toLocaleLowerCase();
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

function FilterSummary({ count, noun, clear }: { count: number; noun: string; clear: () => void }) {
  return <Group justify="space-between" wrap="wrap">
    <Text size="sm" c="dimmed" role="status">{plural(count, noun, noun === "entry" ? "entries" : `${noun}s`)} shown</Text>
    <Button variant="subtle" size="xs" onClick={clear}>Clear filters</Button>
  </Group>;
}

const filterStyle = { flex: "1 1 180px", minWidth: 0 };

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
  const filters = useReportFilters("journal", { event: "", q: "", from: "", to: "" });
  const { event, q, from, to } = filters.values;
  const validRange = !from || !to || from <= to;
  const journal = useInfiniteQuery({
    queryKey: ["journal", event, q, from, to],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ take: String(PAGE), skip: String(pageParam) });
      for (const [key, value] of Object.entries({ event, q, from, to })) if (value) params.set(key, value);
      return get<JournalEntry[]>(`/journal?${params}`);
    },
    getNextPageParam: (last, pages) => last.length === PAGE ? pages.length * PAGE : undefined,
    enabled: validRange,
  });
  const entries = journal.data?.pages.flat() ?? [];
  const receipts = useQuery({
    queryKey: ["journal-receipts"],
    queryFn: () => get<{ id: number; poId: number }[]>("/receipts"),
    enabled: entries.some((entry) => entry.sourceType === "RECEIPT"),
  });
  const poByReceipt = new Map((receipts.data ?? []).map((receipt) => [receipt.id, receipt.poId]));
  const sourceUrl = (entry: JournalEntry) => {
    switch (entry.sourceType) {
      case "BILL":
      case "BILL_VOID":
        return `/bills/${entry.sourceId}`;
      case "PAYMENT":
        return entry.billId ? `/bills/${entry.billId}` : null;
      case "RECEIPT": {
        const poId = poByReceipt.get(entry.sourceId);
        return poId ? `/orders/${poId}` : null;
      }
      default:
        return null;
    }
  };
  const lines = entries.flatMap((e) => e.lines);
  const total = (side: "DEBIT" | "CREDIT") => lines.filter((l) => l.side === side).reduce((s, l) => s + l.amountCents, 0);
  return (
    <Stack>
      <Group align="flex-end" wrap="wrap">
        <Select
          label="Transaction type"
          placeholder="All transaction types"
          data={Object.entries(EVENTS).map(([value, e]) => ({ value, label: e.label }))}
          value={event || null}
          onChange={(value) => filters.set("event", value ?? "")}
          clearable
          style={filterStyle}
        />
        <TextInput label="Search entries" placeholder="Entry, memo, actor or account" value={q} onChange={(e) => filters.set("q", e.currentTarget.value)} style={filterStyle} />
        <TextInput type="date" label="From (UTC)" value={from} max={to || undefined} onChange={(e) => filters.set("from", e.currentTarget.value)} style={filterStyle} />
        <TextInput type="date" label="To (UTC)" value={to} min={from || undefined} onChange={(e) => filters.set("to", e.currentTarget.value)} style={filterStyle} />
      </Group>
      <FilterSummary count={entries.length} noun="entry" clear={filters.clear} />
      {!validRange ? (
        <Text c="dimmed">End date must be on or after start date.</Text>
      ) : journal.isError ? (
        <Alert color="orange" title="Could not load journal entries">{journal.error.message}</Alert>
      ) : journal.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <div className="ruled-empty">{filters.active ? "Nothing matches these filters." : "Nothing is posted yet. Entries appear here as bills, receipts and payments post."}</div>
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
                            {sourceUrl(e) ? <Link to={sourceUrl(e)!} target="_blank" rel="noopener">{e.number}</Link> : e.number}
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
      {validRange && journal.hasNextPage ? (
        <Button variant="subtle" w="fit-content" onClick={() => void journal.fetchNextPage()} loading={journal.isFetching}>
          Show {PAGE} more
        </Button>
      ) : null}
    </Stack>
  );
}

function InventoryMovementReport() {
  const [defaultRange] = useState(() => {
    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 29);
    return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  });
  const filters = useReportFilters("movement", { ...defaultRange, q: "", brand: "", category: "" });
  const range = { from: filters.values.from, to: filters.values.to };
  const validRange = Boolean(range.from && range.to && range.from <= range.to);
  const movement = useQuery({
    queryKey: ["inventory-movement", range.from, range.to],
    queryFn: () => get<InventoryMovement>(`/reports/inventory-movement?${new URLSearchParams(range)}`),
    enabled: validRange,
  });
  const allRows = movement.data?.rows ?? [];
  // Filter already-computed rows: opening stock and per-item balances stay intact.
  const rows = allRows.filter((row) => matches(filters.values.q, row.sku, row.name)
    && (!filters.values.brand || row.brand === filters.values.brand)
    && (!filters.values.category || row.category === filters.values.category));
  const options = (key: "brand" | "category") => [...new Set([...allRows.map((row) => row[key]), filters.values[key]].filter((value): value is string => Boolean(value)))].sort();
  return (
    <Stack>
      <Group align="flex-end" wrap="wrap">
        <TextInput style={filterStyle} type="date" label="Start date" value={range.from} max={range.to || undefined} onChange={(e) => filters.set("from", e.currentTarget.value)} />
        <TextInput style={filterStyle} type="date" label="End date" value={range.to} min={range.from || undefined} onChange={(e) => filters.set("to", e.currentTarget.value)} />
        <TextInput label="Search items" placeholder="SKU or name" value={filters.values.q} onChange={(e) => filters.set("q", e.currentTarget.value)} style={filterStyle} />
        <Select label="Brand" placeholder="All brands" data={options("brand")} value={filters.values.brand || null} onChange={(value) => filters.set("brand", value ?? "")} clearable searchable style={filterStyle} />
        <Select label="Category" placeholder="All categories" data={options("category")} value={filters.values.category || null} onChange={(value) => filters.set("category", value ?? "")} clearable searchable style={filterStyle} />
      </Group>
      <FilterSummary count={rows.length} noun="movement" clear={filters.clear} />
      <Text size="sm" c="dimmed">On-hand stock across all warehouses, oldest first. Dates use UTC; ending balance is per item after each movement.</Text>
      {!validRange ? (
        <Text c="dimmed">Choose a start and end date, with the end on or after the start.</Text>
      ) : movement.isError ? (
        <Alert color="orange" title="Could not load inventory movements">{movement.error.message}</Alert>
      ) : !movement.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Text c="dimmed">{filters.active ? "Nothing matches these filters." : "No inventory movements in this date range."}</Text>
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
              {rows.map((row) => (
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
  const filters = useReportFilters("stock", { q: "", hideZero: "" });
  const v = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  if (!v.data) return <Loading />;
  const rows = v.data.rows.filter((row) => matches(filters.values.q, row.sku, row.name)
    && (filters.values.hideZero !== "1" || row.onHand !== 0 || row.held !== 0));
  return (
    <Stack>
      <Group align="flex-end" wrap="wrap">
        <TextInput label="Search items" placeholder="SKU or name" value={filters.values.q} onChange={(e) => filters.set("q", e.currentTarget.value)} style={filterStyle} />
        <Checkbox label="Hide zero stock" checked={filters.values.hideZero === "1"} onChange={(e) => filters.set("hideZero", e.currentTarget.checked ? "1" : "")} mb="xs" />
      </Group>
      <FilterSummary count={rows.length} noun="item" clear={filters.clear} />
      {rows.length === 0 ? <Text c="dimmed">{filters.active ? "Nothing matches these filters." : "No stock items yet."}</Text> : (
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
              {rows.map((r) => (
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
                  <Money cents={rows.reduce((sum, row) => sum + row.valueCents, 0)} />
                </Table.Td>
                <Table.Td ta="right">
                  <Money cents={rows.reduce((sum, row) => sum + row.glCents, 0)} />
                </Table.Td>
                <Table.Td />
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function HeldStock() {
  const filters = useReportFilters("held", { q: "" });
  const held = useQuery({ queryKey: ["held"], queryFn: () => get<Held>("/reports/held") });
  if (!held.data) return <Loading />;
  const rows = held.data.filter((row) => matches(filters.values.q, row.poNumber, row.vendor?.name, row.item.sku, row.item.name));
  return (
    <Stack gap="xs">
      <TextInput label="Search awaiting bill" placeholder="PO number, vendor or item" value={filters.values.q} onChange={(e) => filters.set("q", e.currentTarget.value)} />
      <FilterSummary count={rows.length} noun="line" clear={filters.clear} />
      {rows.length === 0 ? <Text c="dimmed">{filters.active ? "Nothing matches these filters." : "Nothing is waiting for a bill."}</Text> : null}
      <Text c="dimmed">Received at the dock, counted, not yet sellable or valued. Oldest first.</Text>
      {rows.map((h, i) => (
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
  const filters = useReportFilters("toReceive", { q: "", warehouse: "" });
  const data = useQuery({ queryKey: ["to-receive"], queryFn: () => get<ToReceive>("/reports/to-receive") });
  if (!data.data) return <Loading />;
  const warehouses = [...new Map(data.data.orders.flatMap((order) => order.warehouse ? [[String(order.warehouse.id), { value: String(order.warehouse.id), label: `${order.warehouse.name} (${order.warehouse.code})` }] as const] : [])).values()];
  if (filters.values.warehouse && !warehouses.some((warehouse) => warehouse.value === filters.values.warehouse)) {
    warehouses.push({ value: filters.values.warehouse, label: "Selected warehouse (no open orders)" });
  }
  const orders = data.data.orders.filter((order) => matches(filters.values.q, order.poNumber, order.vendor?.name, ...order.lines.flatMap((line) => [line.item.sku, line.item.name]))
    && (!filters.values.warehouse || String(order.warehouse?.id) === filters.values.warehouse));
  return (
    <Stack gap="xs">
      <Group align="flex-end" wrap="wrap">
        <TextInput label="Search orders" placeholder="PO number, vendor or item" value={filters.values.q} onChange={(e) => filters.set("q", e.currentTarget.value)} style={filterStyle} />
        <Select label="Warehouse" placeholder="All warehouses" data={warehouses} value={filters.values.warehouse || null} onChange={(value) => filters.set("warehouse", value ?? "")} clearable searchable style={filterStyle} />
      </Group>
      <FilterSummary count={orders.length} noun="order" clear={filters.clear} />
      {orders.length === 0 ? <Text c="dimmed">{filters.active ? "Nothing matches these filters." : "Everything ordered has arrived."}</Text> : null}
      <Text c="dimmed">
        {plural(orders.reduce((sum, order) => sum + order.units, 0), "unit")} on order, about {usd(orders.reduce((sum, order) => sum + order.valueCents, 0))} at order cost. Oldest order first. Tap one to receive it.
      </Text>
      {orders.map((o) => (
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
