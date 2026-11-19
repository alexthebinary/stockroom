import { ActionIcon, Alert, Anchor, Button, Card, Collapse, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAdjustmentsHorizontal, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { DataTable } from "../../components/DataTable";
import { useBlurErrors } from "../../components/form";
import { HoldToConfirmButton } from "../../components/kitchen/HoldToConfirmButton";
import { SavedViews } from "../../components/SavedViews";
import { formatDate, Loading, Money, PageHeader, Problem, Stat, StatusBadge, toastErr, toastOk, usd } from "../../components/ui";
import { get, post, put } from "../../lib/api";
import type { Item, Warehouse } from "../../lib/types";

type Customer = { id: number; name: string; termsDays: number };
type SalesLine = {
  id: number;
  itemId: number;
  qtyOrdered: number;
  unitPriceCents: number;
  qtyShipped: number;
  qtyInvoiced: number;
  item?: { sku: string; name: string };
};
type InvoiceSummary = { id: number; number: string; status: string; totalCents: number; paidCents: number; openCents: number; dueDate: string };
type SalesOrder = {
  id: number;
  number: string;
  customerId: number | null;
  customer?: Customer | null;
  warehouseId: number;
  warehouse?: Warehouse | null;
  lifecycle: string;
  invoicingStatus: string;
  paymentStatus: string;
  shippingStatus: string;
  notes: string | null;
  version: number;
  createdAt: string;
  createdBy: string;
  lines: SalesLine[];
  subtotalCents: number;
  shippingCents: number;
  taxRatePct: number;
  taxCents: number;
  totalCents: number;
  invoices?: InvoiceSummary[];
};
type Invoice = InvoiceSummary & {
  subtotalCents: number;
  shippingCents: number;
  taxRatePct: number;
  taxCents: number;
  customer?: Customer | null;
  salesOrder?: { id: number; number: string } | null;
  termsDays: number;
  invoiceDate: string;
  lines: { id: number; qty: number; unitPriceCents: number; amountCents: number; item?: { sku: string; name: string } | null }[];
  payments: { id: number; number: string; amountCents: number; paidAt: string; method: string }[];
};

/** Subtotal, Shipping & Handling, Sales Tax (rate and amount), Total: always in this order, Total last. */
export function SalesTotals({ subtotalCents, shippingCents, taxRatePct, taxCents, totalCents }: { subtotalCents: number; shippingCents: number; taxRatePct: number; taxCents: number; totalCents: number }) {
  return (
    <Stack gap={4} maw={360} ml="auto" aria-label="Order totals">
      <Group justify="space-between"><Text>Subtotal</Text><Money cents={subtotalCents} /></Group>
      <Group justify="space-between"><Text>Shipping &amp; Handling</Text><Money cents={shippingCents} /></Group>
      <Group justify="space-between"><Text>Sales Tax ({taxRatePct}%)</Text><Money cents={taxCents} /></Group>
      <Group justify="space-between"><Text fw={700}>Total</Text><Text fw={700}><Money cents={totalCents} /></Text></Group>
    </Stack>
  );
}

const filterKeys = ["search", "customerId", "invoicingStatus", "paymentStatus", "shippingStatus", "lifecycle", "from", "to"] as const;
type FilterKey = (typeof filterKeys)[number];
const filterOptions = {
  invoicingStatus: [{ value: "NOT_INVOICED", label: "Not invoiced" }, { value: "PARTIAL", label: "Part invoiced" }, { value: "INVOICED", label: "Invoiced" }],
  paymentStatus: [{ value: "UNPAID", label: "Unpaid" }, { value: "PARTIAL", label: "Part paid" }, { value: "PAID", label: "Paid" }],
  shippingStatus: [{ value: "NOT_SHIPPED", label: "Not shipped" }, { value: "PARTIAL", label: "Part shipped" }, { value: "SHIPPED", label: "Shipped" }],
  lifecycle: [{ value: "OPEN", label: "Open" }, { value: "ALL", label: "All" }, { value: "CLOSED", label: "Closed / cancelled" }],
};

function readFilters(params: URLSearchParams): Record<FilterKey, string> {
  const choice = (key: keyof typeof filterOptions, fallback = "") =>
    filterOptions[key].some((option) => option.value === params.get(key)) ? params.get(key)! : fallback;
  return {
    search: params.get("search") ?? "",
    customerId: params.get("customerId") ?? "",
    invoicingStatus: choice("invoicingStatus"),
    paymentStatus: choice("paymentStatus"),
    shippingStatus: choice("shippingStatus"),
    lifecycle: choice("lifecycle", "OPEN"),
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
}

function filterOrders(orders: SalesOrder[], filters: Record<FilterKey, string>) {
  const search = filters.search.trim().toLowerCase();
  const from = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : NaN;
  const until = filters.to ? new Date(`${filters.to}T00:00:00`) : null;
  until?.setDate(until.getDate() + 1);
  const end = until?.getTime() ?? NaN;
  return orders.filter((order) => {
    if (filters.lifecycle === "OPEN" && order.lifecycle !== "OPEN") return false;
    if (filters.lifecycle === "CLOSED" && order.lifecycle !== "CLOSED" && order.lifecycle !== "CANCELED") return false;
    if (filters.customerId && String(order.customerId) !== filters.customerId) return false;
    if (filters.invoicingStatus && order.invoicingStatus !== filters.invoicingStatus) return false;
    if (filters.paymentStatus && order.paymentStatus !== filters.paymentStatus) return false;
    if (filters.shippingStatus && order.shippingStatus !== filters.shippingStatus) return false;
    const created = new Date(order.createdAt).getTime();
    if (!Number.isNaN(from) && created < from) return false;
    if (!Number.isNaN(end) && created >= end) return false;
    return !search || [order.number, order.customer?.name, ...order.lines.flatMap((line) => [line.item?.sku, line.item?.name])]
      .some((value) => value?.toLowerCase().includes(search));
  });
}

function Axes({ order }: { order: SalesOrder }) {
  return (
    <Group gap={6}>
      <StatusBadge status={order.invoicingStatus} label={order.invoicingStatus === "PARTIAL" ? "Part invoiced" : undefined} />
      <StatusBadge status={order.paymentStatus} />
      <StatusBadge status={order.shippingStatus} label={order.shippingStatus === "PARTIAL" ? "Part shipped" : undefined} />
    </Group>
  );
}

export function SalesOrders() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const filters = readFilters(searchParams);
  const updateFilter = (key: FilterKey, value: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value && !(key === "lifecycle" && value === "OPEN")) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  const clearFilters = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    filterKeys.forEach((key) => next.delete(key));
    return next;
  });
  const [filtersOpen, setFiltersOpen] = useState<boolean | null>(null);
  const activeCount = (["customerId", "invoicingStatus", "paymentStatus", "shippingStatus", "from", "to"] as const).filter((key) => filters[key]).length + (filters.lifecycle !== "OPEN" ? 1 : 0);
  const showFilters = filtersOpen ?? activeCount > 0;
  const orders = useQuery({ queryKey: ["sales-orders", "ALL"], queryFn: () => get<SalesOrder[]>("/sales-orders?lifecycle=ALL") });
  if (orders.error) return <><PageHeader title="Sales orders" /><Problem error={orders.error} retry={() => void orders.refetch()} /></>;
  if (!orders.data) return <><PageHeader title="Sales orders" /><Loading /></>;
  const filtered = filterOrders(orders.data, filters);
  const customers = [...new Map(orders.data.flatMap((order) => order.customer ? [[String(order.customer.id), order.customer.name] as const] : [])).entries()]
    .map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <>
      <PageHeader
        title="Sales orders"
        subtitle="An order commits to sell. Ship takes the stock out, and the invoice posts what the customer owes."
        action={<Button component={Link} to="/sales/orders/new" leftSection={<IconPlus size={18} />}>New</Button>}
      />
      <Coach id="sales-orders" title="Selling">
        Create the order, ship the units, then create the invoice. A payment on the invoice clears what the customer owes.
      </Coach>
      <Stack gap="sm" mb="lg">
        <TextInput label="Search orders" placeholder="SO number, customer, item SKU or name" value={filters.search} onChange={(event) => updateFilter("search", event.currentTarget.value)} />
        <Group>
          <Button variant="default" size="compact-md" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={() => setFiltersOpen(!showFilters)} aria-expanded={showFilters} aria-controls="sales-order-filters">
            Filters{activeCount ? ` (${activeCount})` : ""}
          </Button>
        </Group>
        <Collapse expanded={showFilters} id="sales-order-filters">
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} style={{ minWidth: 0 }}>
            <Select label="Customer" placeholder="All customers" data={customers} value={filters.customerId || null} onChange={(value) => updateFilter("customerId", value)} searchable clearable nothingFoundMessage="No customers found" />
            <Select label="Invoicing" placeholder="All invoicing statuses" data={filterOptions.invoicingStatus} value={filters.invoicingStatus || null} onChange={(value) => updateFilter("invoicingStatus", value)} clearable />
            <Select label="Payment" placeholder="All payment statuses" data={filterOptions.paymentStatus} value={filters.paymentStatus || null} onChange={(value) => updateFilter("paymentStatus", value)} clearable />
            <Select label="Shipping" placeholder="All shipping statuses" data={filterOptions.shippingStatus} value={filters.shippingStatus || null} onChange={(value) => updateFilter("shippingStatus", value)} clearable />
            <Select label="Lifecycle" data={filterOptions.lifecycle} value={filters.lifecycle} onChange={(value) => updateFilter("lifecycle", value)} allowDeselect={false} />
            <TextInput type="date" label="Created from" value={filters.from} onChange={(event) => updateFilter("from", event.currentTarget.value)} />
            <TextInput type="date" label="Created to" value={filters.to} onChange={(event) => updateFilter("to", event.currentTarget.value)} />
          </SimpleGrid>
        </Collapse>
        <SavedViews
          storageKey="sales-orders"
          current={Object.fromEntries(filterKeys.flatMap((key) => (searchParams.get(key) ? [[key, searchParams.get(key)!] as const] : [])))}
          apply={(values) => setSearchParams((cur) => { const next = new URLSearchParams(cur); filterKeys.forEach((key) => next.delete(key)); Object.entries(values).forEach(([k, v]) => next.set(k, v)); return next; }, { replace: true })}
        />
        <Group justify="space-between">
          <Text size="sm" c="dimmed" role="status">{filtered.length} of {orders.data.length} orders</Text>
          {activeCount > 0 || filters.search ? <Button variant="subtle" onClick={clearFilters}>Clear filters</Button> : null}
        </Group>
      </Stack>
      <DataTable
        id="sales-orders"
        prefetch={(order) => void queryClient.prefetchQuery({ queryKey: ["sales-order", String(order.id)], queryFn: () => get(`/sales-orders/${order.id}`), staleTime: 30_000 })}
        label="Sales orders"
        rows={filtered}
        rowKey={(order) => order.id}
        to={(order) => `/sales/orders/${order.id}`}
        selectable={{ filename: "sales-orders-selected.csv", csv: (order) => ({ Order: order.number, Customer: order.customer?.name, Created: formatDate(order.createdAt), By: order.createdBy, Invoicing: order.invoicingStatus, Payment: order.paymentStatus, Shipping: order.shippingStatus, Total: (order.totalCents / 100).toFixed(2) }) }}
        empty={orders.data.length ? "No orders match these filters." : <><div>No sales orders yet.</div><Button component={Link} to="/sales/orders/new" size="compact-md" mt="sm">New sales order</Button></>}
        columns={[
          { key: "number", label: "Order", width: 130, primary: true, strong: true, render: (order) => order.number },
          { key: "customer", label: "Customer", render: (order) => order.customer?.name ?? "Customer not set" },
          { key: "date", label: "Created", width: 120, render: (order) => formatDate(order.createdAt) },
          { key: "by", label: "By", width: 110, render: (order) => order.createdBy },
          { key: "invoicing", label: "Invoicing", width: 140, render: (order) => <StatusBadge status={order.invoicingStatus} label={order.invoicingStatus === "PARTIAL" ? "Part invoiced" : undefined} /> },
          { key: "payment", label: "Payment", width: 110, render: (order) => <StatusBadge status={order.paymentStatus} /> },
          { key: "shipping", label: "Shipping", width: 140, render: (order) => <StatusBadge status={order.shippingStatus} label={order.shippingStatus === "PARTIAL" ? "Part shipped" : undefined} /> },
          { key: "total", label: "Total", width: 120, align: "right", strong: true, render: (order) => <Money cents={order.totalCents} /> },
        ]}
        phone={(order) => ({
          title: `${order.number} · ${order.customer?.name ?? "Customer not set"}`,
          meta: <Stack gap={6} mt={4}><span>By {order.createdBy} · {formatDate(order.createdAt)}{order.lifecycle !== "OPEN" ? ` · ${order.lifecycle.toLowerCase()}` : ""}</span><Axes order={order} /></Stack>,
          aside: <Text fw={600}><Money cents={order.totalCents} /></Text>,
        })}
      />
    </>
  );
}

type DraftLine = { key: string; id?: number; itemId: string | null; qty: number; price: number; qtyShipped: number; qtyInvoiced: number };

export function NewSalesOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => get<Customer[]>("/customers") });
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ itemId: null as string | null, qty: 1, price: 0 }]);
  const [shipping, setShipping] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const form = useBlurErrors();
  const stacked = useMediaQuery("(max-width: 899px)") ?? false;
  const sellable = (items.data ?? []).filter((item) => !item.isBundle && item.trackingMode !== "SERIAL");
  const subtotal = lines.reduce((s, l) => s + l.qty * Math.round(l.price * 100), 0);
  const shippingCents = Math.round(shipping * 100);
  const taxCents = Math.round(((subtotal + shippingCents) * Math.round(taxRate * 100)) / 10000);
  const named = Boolean(customerId) || customerName.trim().length > 0;
  const valid = named && lines.every((l) => l.itemId);
  const loadError = customers.error ?? warehouses.error ?? items.error;
  const label = (i: number, text: string) => (stacked || i === 0 ? { label: text } : { "aria-label": `${text}, line ${i + 1}` });
  const save = async () => {
    if (busy || !form.submit(valid)) return;
    setBusy(true);
    setFailed("");
    try {
      let id = customerId ? Number(customerId) : 0;
      if (!id) {
        const created = await post<Customer>("/customers", { name: customerName.trim() });
        id = created.id;
      }
      const order = await post<SalesOrder>("/sales-orders", {
        customerId: id,
        warehouseId: Number(warehouseId ?? warehouses.data?.[0]?.id),
        notes: notes || undefined,
        shippingCents,
        taxRatePct: taxRate,
        lines: lines.map((l) => ({ itemId: Number(l.itemId), qtyOrdered: l.qty, unitPriceCents: Math.round(l.price * 100) })),
      });
      toastOk(`${order.number} created`);
      await queryClient.invalidateQueries();
      navigate(`/sales/orders/${order.id}`);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Stack gap="lg" maw={880}>
        <PageHeader back={{ to: "/sales/orders", label: "Sales orders" }} title="New sales order" />
        {loadError ? <Problem error={loadError} retry={() => { void customers.refetch(); void warehouses.refetch(); void items.refetch(); }} /> : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="Customer" placeholder={customers.isLoading ? "Loading customers…" : "Choose a customer"} disabled={customers.isLoading}
            data={(customers.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} value={customerId} onChange={(value) => { setCustomerId(value); if (value) setCustomerName(""); }} searchable clearable
            nothingFoundMessage="No customer by that name. Type a new name below."
            onBlur={form.blur("customer")} error={form.show("customer", named ? null : "Choose a customer, or type a new name.")}
          />
          <TextInput label="Or a new customer" placeholder="Name" value={customerName} disabled={Boolean(customerId)} onChange={(e) => setCustomerName(e.currentTarget.value)} onBlur={form.blur("customer")} />
          <Select label="Ship from" disabled={warehouses.isLoading} data={(warehouses.data ?? []).map((w) => ({ value: String(w.id), label: w.name }))} value={warehouseId ?? (warehouses.data?.[0] ? String(warehouses.data[0].id) : null)} onChange={setWarehouseId} allowDeselect={false} />
        </SimpleGrid>
        <Stack gap="sm" role="group" aria-label="Order lines">
          {lines.map((line, i) => (
            <div key={i} className="form-line" data-labelled={stacked || i === 0 ? "true" : undefined}>
              <Select
                {...label(i, "Item")} withAsterisk={stacked || i === 0} placeholder={items.isLoading ? "Loading items…" : "Search by SKU or name"} disabled={items.isLoading}
                data={sellable.map((it) => ({ value: String(it.id), label: `${it.sku} · ${it.name}` }))} value={line.itemId}
                onChange={(value) => {
                  const item = sellable.find((it) => String(it.id) === value);
                  setLines(lines.map((l, j) => (j === i ? { ...l, itemId: value, price: item?.priceCents != null ? item.priceCents / 100 : l.price } : l)));
                }}
                searchable nothingFoundMessage="No item matches. Add it in Stock first."
                onBlur={form.blur(`item-${i}`)} error={form.show(`item-${i}`, line.itemId ? null : lines.length > 1 ? "Choose an item, or remove this line." : "Choose the item to sell.")}
              />
              <NumberInput {...label(i, "Qty")} value={line.qty} min={1} allowDecimal={false} hideControls inputMode="numeric" onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, qty: Number(v) || 1 } : l)))} />
              <NumberInput {...label(i, "Price $")} value={line.price} min={0} decimalScale={2} hideControls inputMode="decimal" onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, price: Number(v) || 0 } : l)))} />
              <ActionIcon className="form-line-remove" variant="subtle" color="ink" size={44} onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1} aria-label={lines.length === 1 ? "Remove line (an order needs at least one)" : `Remove line ${i + 1}`}>
                <IconTrash size={18} aria-hidden="true" />
              </ActionIcon>
            </div>
          ))}
          <Group><Button variant="light" onClick={() => setLines([...lines, { itemId: null, qty: 1, price: 0 }])}>Add line</Button></Group>
        </Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label="Shipping & Handling $" value={shipping} min={0} decimalScale={2} hideControls inputMode="decimal" onChange={(v) => setShipping(Number(v) || 0)} />
          <NumberInput label="Sales Tax rate %" value={taxRate} min={0} max={100} decimalScale={2} hideControls inputMode="decimal" onChange={(v) => setTaxRate(Number(v) || 0)} />
        </SimpleGrid>
        <Textarea label="Notes" description="Optional. Shown on the order." value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={2} />
        {failed ? <Alert role="alert" color="orange" title="The order was not created">{failed} Nothing was saved.</Alert> : null}
        <div aria-live="polite">
          <SalesTotals subtotalCents={subtotal} shippingCents={shippingCents} taxRatePct={taxRate} taxCents={taxCents} totalCents={subtotal + shippingCents + taxCents} />
        </div>
        <Group justify="flex-end">
          <Button size="md" type="submit" loading={busy}>Create order</Button>
        </Group>
      </Stack>
    </form>
  );
}

export function SalesOrderDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const order = useQuery({ queryKey: ["sales-order", id], queryFn: () => get<SalesOrder>(`/sales-orders/${id}`) });
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const [notes, setNotes] = useState("");
  const [shipping, setShipping] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState("");
  useEffect(() => {
    if (!order.data) return;
    const next = `${order.data.id}:${order.data.version}`;
    if (next === seed) return;
    setSeed(next);
    setNotes(order.data.notes ?? "");
    setShipping(order.data.shippingCents / 100);
    setTaxRate(order.data.taxRatePct);
    setLines(order.data.lines.map((line) => ({
      key: String(line.id),
      id: line.id,
      itemId: String(line.itemId),
      qty: line.qtyOrdered,
      price: line.unitPriceCents / 100,
      qtyShipped: line.qtyShipped,
      qtyInvoiced: line.qtyInvoiced,
    })));
  }, [order.data, seed]);
  if (order.error) return <Problem error={order.error} retry={() => void order.refetch()} />;
  if (!order.data) return <Loading />;
  const current = order.data;
  const open = current.lifecycle === "OPEN";
  const sellable = (items.data ?? []).filter((item) => !item.isBundle && item.trackingMode !== "SERIAL");
  const act = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      toastOk(done);
      await queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(async () => {
    await put(`/sales-orders/${current.id}`, {
      version: current.version,
      notes,
      shippingCents: Math.round(shipping * 100),
      taxRatePct: taxRate,
      lines: lines.map((line) => ({
        ...(line.id ? { id: line.id } : {}),
        itemId: Number(line.itemId),
        qtyOrdered: line.qty,
        unitPriceCents: Math.round(line.price * 100),
      })),
    });
  }, `${current.number} saved`);
  return (
    <Stack gap="lg">
      <PageHeader back={{ to: "/sales/orders", label: "Sales orders" }} title={current.number} subtitle={`${current.customer?.name ?? "Customer not set"} · from ${current.warehouse?.name ?? "warehouse"} · by ${current.createdBy}`} action={<Axes order={current} />} />
      <Card withBorder className="section">
        <Table.ScrollContainer minWidth={640}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item</Table.Th>
                <Table.Th ta="right">Ordered</Table.Th>
                <Table.Th ta="right">Shipped</Table.Th>
                <Table.Th ta="right">Invoiced</Table.Th>
                <Table.Th ta="right">Price</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((line, i) => (
                <Table.Tr key={line.key}>
                  <Table.Td>
                    {line.id ? (current.lines.find((l) => l.id === line.id)?.item?.name ?? "Item") : (
                      <Select aria-label={`Item, line ${i + 1}`} data={sellable.map((it) => ({ value: String(it.id), label: `${it.sku} · ${it.name}` }))} value={line.itemId} onChange={(value) => setLines(lines.map((l, j) => j === i ? { ...l, itemId: value } : l))} searchable placeholder="Item" />
                    )}
                  </Table.Td>
                  <Table.Td ta="right">
                    {open ? <NumberInput aria-label={`Quantity, line ${i + 1}`} value={line.qty} min={Math.max(1, line.qtyShipped, line.qtyInvoiced)} allowDecimal={false} hideControls w={88} ml="auto" onChange={(v) => setLines(lines.map((l, j) => j === i ? { ...l, qty: Number(v) || 1 } : l))} /> : line.qty}
                  </Table.Td>
                  <Table.Td ta="right">{line.qtyShipped}</Table.Td>
                  <Table.Td ta="right">{line.qtyInvoiced}</Table.Td>
                  <Table.Td ta="right">
                    {open && line.qtyInvoiced === 0 ? <NumberInput aria-label={`Price, line ${i + 1}`} value={line.price} min={0} decimalScale={2} hideControls w={110} ml="auto" onChange={(v) => setLines(lines.map((l, j) => j === i ? { ...l, price: Number(v) || 0 } : l))} /> : usd(Math.round(line.price * 100))}
                  </Table.Td>
                  <Table.Td>
                    {open && line.qtyShipped === 0 && line.qtyInvoiced === 0 && lines.length > 1 ? (
                      <ActionIcon variant="subtle" color="ink" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><IconTrash size={16} /></ActionIcon>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {open ? (
          <Group mt="sm" justify="space-between">
            <Button variant="light" onClick={() => setLines([...lines, { key: `new-${lines.length}-${Date.now()}`, itemId: null, qty: 1, price: 0, qtyShipped: 0, qtyInvoiced: 0 }])}>Add line</Button>
            <Button onClick={() => void save()} loading={busy} disabled={lines.some((line) => !line.itemId)}>Save lines</Button>
          </Group>
        ) : null}
        {open ? (
          <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
            <NumberInput label="Shipping & Handling $" value={shipping} min={0} decimalScale={2} hideControls onChange={(v) => setShipping(Number(v) || 0)} />
            <NumberInput label="Sales Tax rate %" value={taxRate} min={0} max={100} decimalScale={2} hideControls onChange={(v) => setTaxRate(Number(v) || 0)} />
          </SimpleGrid>
        ) : null}
        <Group mt="md" justify="flex-end"><SalesTotals {...current} /></Group>
      </Card>
      <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} disabled={!open} autosize minRows={2} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder className="section">
          <Title order={3} mb="xs">Invoices</Title>
          {(current.invoices ?? []).length === 0 ? <Text c="dimmed">Nothing invoiced yet.</Text> : null}
          {(current.invoices ?? []).map((invoice) => (
            <Group key={invoice.id} justify="space-between">
              <Anchor component={Link} to={`/sales/invoices/${invoice.id}`}>{invoice.number}</Anchor>
              <Group gap="xs"><Money cents={invoice.totalCents} /><StatusBadge status={invoice.status} /></Group>
            </Group>
          ))}
          {open && current.invoicingStatus !== "INVOICED" ? (
            <HoldToConfirmButton onConfirm={() => act(() => post(`/sales-orders/${current.id}/invoice`), "Invoice posted")} busy={busy} confirmed="Posting…">
              Hold to create invoice
            </HoldToConfirmButton>
          ) : null}
        </Card>
        <Card withBorder className="section">
          <Title order={3} mb="xs">Shipment</Title>
          <Text c="dimmed" size="sm" mb="sm">Ship takes the remaining units out at average cost and posts cost of goods sold.</Text>
          {open && current.shippingStatus !== "SHIPPED" ? (
            <HoldToConfirmButton onConfirm={() => act(() => post(`/sales-orders/${current.id}/ship`), `${current.number} shipped`)} busy={busy} confirmed="Shipping…">
              Hold to ship remaining
            </HoldToConfirmButton>
          ) : <Text>{current.shippingStatus === "SHIPPED" ? "Everything on this order has shipped." : "This order is cancelled."}</Text>}
          {open && current.shippingStatus === "NOT_SHIPPED" && current.invoicingStatus === "NOT_INVOICED" ? (
            <Button mt="sm" variant="default" color="red" loading={busy} onClick={() => void act(() => post(`/sales-orders/${current.id}/cancel`), `${current.number} cancelled`)}>Cancel order</Button>
          ) : null}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

export function Invoices() {
  const invoices = useQuery({ queryKey: ["customer-invoices"], queryFn: () => get<Invoice[]>("/customer-invoices") });
  if (invoices.error) return <><PageHeader title="Invoices" /><Problem error={invoices.error} retry={() => void invoices.refetch()} /></>;
  if (!invoices.data) return <><PageHeader title="Invoices" /><Loading /></>;
  return (
    <>
      <PageHeader title="Invoices" subtitle="Posted from a sales order. A payment clears what the customer still owes." />
      <DataTable
        id="customer-invoices"
        label="Invoices"
        rows={invoices.data}
        rowKey={(invoice) => invoice.id}
        to={(invoice) => `/sales/invoices/${invoice.id}`}
        selectable={{ filename: "invoices-selected.csv", csv: (invoice) => ({ Invoice: invoice.number, Customer: invoice.customer?.name, Order: invoice.salesOrder?.number, Status: invoice.status, Due: formatDate(invoice.dueDate), Total: (invoice.totalCents / 100).toFixed(2), Open: (invoice.openCents / 100).toFixed(2) }) }}
        empty="No invoices yet. Create one from a sales order."
        columns={[
          { key: "number", label: "Invoice", width: 140, primary: true, strong: true, render: (invoice) => invoice.number },
          { key: "customer", label: "Customer", render: (invoice) => invoice.customer?.name ?? "—" },
          { key: "order", label: "Order", width: 130, render: (invoice) => invoice.salesOrder?.number ?? "—" },
          { key: "due", label: "Due", width: 120, render: (invoice) => formatDate(invoice.dueDate) },
          { key: "status", label: "Status", width: 110, render: (invoice) => <StatusBadge status={invoice.status} /> },
          { key: "open", label: "Open", width: 120, align: "right", strong: true, render: (invoice) => <Money cents={invoice.openCents} /> },
        ]}
        phone={(invoice) => ({
          title: `${invoice.number} · ${invoice.customer?.name ?? ""}`,
          meta: <span>Due {formatDate(invoice.dueDate)} · {invoice.status.toLowerCase()}</span>,
          aside: <Text fw={600}><Money cents={invoice.openCents} /></Text>,
        })}
      />
    </>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const invoice = useQuery({ queryKey: ["customer-invoice", id], queryFn: () => get<Invoice>(`/customer-invoices/${id}`) });
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  useEffect(() => {
    if (invoice.data) setAmount(invoice.data.openCents / 100);
  }, [invoice.data]);
  if (invoice.error) return <Problem error={invoice.error} retry={() => void invoice.refetch()} />;
  if (!invoice.data) return <Loading />;
  const current = invoice.data;
  const act = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      toastOk(done);
      setVoiding(false);
      await queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="lg">
      <PageHeader
        back={{ to: "/sales/invoices", label: "Invoices" }}
        title={current.number}
        subtitle={`${current.customer?.name ?? "Customer"} · due ${formatDate(current.dueDate)}${current.salesOrder ? ` · ${current.salesOrder.number}` : ""}`}
        action={<StatusBadge status={current.status} />}
      />
      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        <Card withBorder className="section"><Text size="sm" c="dimmed">Total</Text><Money cents={current.totalCents} /></Card>
        <Card withBorder className="section"><Text size="sm" c="dimmed">Open</Text><Money cents={current.openCents} /></Card>
      </SimpleGrid>
      <Card withBorder className="section">
        <Table>
          <Table.Thead><Table.Tr><Table.Th>Item</Table.Th><Table.Th ta="right">Qty</Table.Th><Table.Th ta="right">Price</Table.Th><Table.Th ta="right">Amount</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {current.lines.map((line) => (
              <Table.Tr key={line.id}>
                <Table.Td>{line.item ? `${line.item.sku} · ${line.item.name}` : "—"}</Table.Td>
                <Table.Td ta="right">{line.qty}</Table.Td>
                <Table.Td ta="right">{usd(line.unitPriceCents)}</Table.Td>
                <Table.Td ta="right"><Money cents={line.amountCents} /></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group mt="md" justify="flex-end"><SalesTotals {...current} /></Group>
      </Card>
      {current.payments.length > 0 ? (
        <Card withBorder className="section">
          <Title order={3} mb="xs">Payments</Title>
          {current.payments.map((payment) => (
            <Group key={payment.id} justify="space-between">
              <Text>{payment.number} · {formatDate(payment.paidAt)} · {payment.method}</Text>
              <Money cents={payment.amountCents} />
            </Group>
          ))}
        </Card>
      ) : null}
      {current.status === "POSTED" && current.openCents > 0 ? (
        <Card withBorder className="section">
          <Title order={3} mb="xs">Record payment</Title>
          <Group align="flex-end">
            <NumberInput label="Amount $" value={amount} min={0} decimalScale={2} onChange={(v) => setAmount(Number(v) || 0)} w={160} />
            <HoldToConfirmButton onConfirm={() => act(() => post(`/customer-invoices/${current.id}/payments`, { amountCents: Math.round(amount * 100) }), "Payment recorded")} busy={busy} disabled={Math.round(amount * 100) <= 0} confirmed="Recording…">
              Hold to record payment
            </HoldToConfirmButton>
          </Group>
        </Card>
      ) : null}
      {current.status === "POSTED" && current.paidCents === 0 ? (
        <Card withBorder className="section">
          {voiding ? (
            <>
              <Text size="sm" mb="sm">Voiding reverses the invoice entry. Stock that already shipped stays shipped.</Text>
              <HoldToConfirmButton tone="danger" duration={1400} onConfirm={() => act(() => post(`/customer-invoices/${current.id}/void`), `${current.number} voided`)} busy={busy} confirmed="Voiding…">
                Hold to void {current.number}
              </HoldToConfirmButton>
            </>
          ) : <Button variant="default" onClick={() => setVoiding(true)}>Void…</Button>}
        </Card>
      ) : null}
    </Stack>
  );
}

type Aging = {
  customers: {
    customer: { id: number; name: string };
    totalCents: number;
    invoices: { id: number; number: string; dueDate: string; openCents: number; bucket: string }[];
  }[];
};

export function Receivables() {
  const aging = useQuery({ queryKey: ["ar-aging"], queryFn: () => get<Aging>("/reports/ar-aging") });
  if (aging.error) return <><PageHeader title="Receivables" /><Problem error={aging.error} retry={() => void aging.refetch()} /></>;
  if (!aging.data) return <><PageHeader title="Receivables" /><Loading /></>;
  const customers = aging.data.customers;
  const total = customers.reduce((s, c) => s + c.totalCents, 0);
  const late = customers.reduce((s, c) => s + c.invoices.filter((i) => i.bucket !== "current").reduce((x, i) => x + i.openCents, 0), 0);
  return (
    <>
      <PageHeader title="Receivables" subtitle="Posted invoices not yet settled, by due date." />
      <Coach id="receivables" title="Collecting">
        Open an invoice and record the payment, in full or in part. Current means it is not late yet.
      </Coach>
      <SimpleGrid cols={{ base: 2, sm: 3 }} mb="lg" spacing="lg">
        <Stat label="They owe" value={usd(total)} />
        <Stat label="Past due" value={usd(late)} />
        <Stat label="Customers" value={customers.length} />
      </SimpleGrid>
      {customers.length === 0 ? <Text c="dimmed">Nothing owed.</Text> : (
        <Table.ScrollContainer minWidth={560}>
          <Table>
            <Table.Thead>
              <Table.Tr><Table.Th>Customer / invoice</Table.Th><Table.Th>Due</Table.Th><Table.Th ta="right">Open</Table.Th></Table.Tr>
            </Table.Thead>
            {customers.map((row) => (
              <Table.Tbody key={row.customer.id}>
                <Table.Tr style={{ background: "var(--surface-sunken)" }}>
                  <Table.Td colSpan={2} fw={600}>{row.customer.name}</Table.Td>
                  <Table.Td ta="right" fw={600}><Money cents={row.totalCents} /></Table.Td>
                </Table.Tr>
                {row.invoices.map((invoice) => (
                  <Table.Tr key={invoice.id}>
                    <Table.Td pl={24}><Anchor component={Link} to={`/sales/invoices/${invoice.id}`}>{invoice.number}</Anchor></Table.Td>
                    <Table.Td c={invoice.bucket === "current" ? undefined : "var(--warn-fg)"}>{invoice.bucket === "current" ? formatDate(invoice.dueDate) : `${invoice.bucket} days late`}</Table.Td>
                    <Table.Td ta="right"><Money cents={invoice.openCents} /></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            ))}
          </Table>
        </Table.ScrollContainer>
      )}
    </>
  );
}
