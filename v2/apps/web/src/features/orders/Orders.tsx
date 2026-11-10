import { ActionIcon, Anchor, Button, Card, Collapse, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAdjustmentsHorizontal, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DataTable } from "../../components/DataTable";
import { formatDate, Loading, Money, PageHeader, ReceivingBadge, StatusBadge, toastErr, toastOk, usd } from "../../components/ui";
import { get, post } from "../../lib/api";
import { filterOrders, orderFilterKeys, orderFilterOptions, readOrderFilters, type OrderFilterKey } from "../../lib/orderFilters";
import type { Item, PurchaseOrder, Vendor, Warehouse } from "../../lib/types";

function Axes({ po }: { po: PurchaseOrder }) {
  return (
    <Group gap={6}>
      <StatusBadge status={po.billingStatus} />
      <StatusBadge status={po.paymentStatus} />
      <ReceivingBadge status={po.receivingStatus} held={po.heldUnits ?? po.lines.reduce((s, l) => s + l.qtyHeld, 0)} />
    </Group>
  );
}

/** Purchase orders. Each shows the WMS doc's three independent statuses: billed, paid, received. */
export function Orders() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readOrderFilters(searchParams);
  const updateFilter = (key: OrderFilterKey, value: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value && !(key === "lifecycle" && value === "OPEN")) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  const clearFilters = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    orderFilterKeys.forEach((key) => next.delete(key));
    return next;
  });
  const wide = useMediaQuery("(min-width: 900px)") ?? true;
  const activeCount = (["vendorId", "billingStatus", "paymentStatus", "receivingStatus", "from", "to"] as const).filter((key) => filters[key]).length + (filters.lifecycle !== "OPEN" ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState<boolean | null>(null);
  const showFilters = filtersOpen ?? activeCount > 0;
  const orders = useQuery({ queryKey: ["orders", "ALL"], queryFn: () => get<PurchaseOrder[]>("/purchase-orders?lifecycle=ALL") });
  if (!orders.data) return <><PageHeader title="Purchase orders" /><Loading /></>;
  const filtered = filterOrders(orders.data, filters);
  const vendors = [...new Map(orders.data.flatMap((po) => po.vendor ? [[String(po.vendor.id), po.vendor.name] as const] : [])).entries()]
    .map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="An order commits to buy; it posts nothing. Its bill posts the money, and its receipts bring the stock in."
        action={
          <Button component={Link} to="/orders/new" leftSection={<IconPlus size={18} />}>
            New
          </Button>
        }
      />
      <Stack gap="sm" mb="lg">
        <TextInput label="Search orders" placeholder="PO number, vendor, item SKU or name" value={filters.search} onChange={(event) => updateFilter("search", event.currentTarget.value)} />
        <Group>
          <Button variant="default" size="compact-md" leftSection={<IconAdjustmentsHorizontal size={16} />} onClick={() => setFiltersOpen(!showFilters)} aria-expanded={showFilters} aria-controls="order-filters">
            Filters{activeCount ? ` (${activeCount})` : ""}
          </Button>
        </Group>
        <Collapse expanded={showFilters} id="order-filters">
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} style={{ minWidth: 0 }}>
          <Select label="Vendor" placeholder="All vendors" data={vendors} value={filters.vendorId || null} onChange={(value) => updateFilter("vendorId", value)} searchable clearable nothingFoundMessage="No vendors found" />
          <Select label="Billing" placeholder="All billing statuses" data={orderFilterOptions.billingStatus} value={filters.billingStatus || null} onChange={(value) => updateFilter("billingStatus", value)} clearable />
          <Select label="Payment" placeholder="All payment statuses" data={orderFilterOptions.paymentStatus} value={filters.paymentStatus || null} onChange={(value) => updateFilter("paymentStatus", value)} clearable />
          <Select label="Receiving" placeholder="All receiving statuses" data={orderFilterOptions.receivingStatus} value={filters.receivingStatus || null} onChange={(value) => updateFilter("receivingStatus", value)} clearable />
          <Select label="Lifecycle" data={orderFilterOptions.lifecycle} value={filters.lifecycle} onChange={(value) => updateFilter("lifecycle", value)} allowDeselect={false} />
          <TextInput type="date" label="Created from" value={filters.from} onChange={(event) => updateFilter("from", event.currentTarget.value)} />
          <TextInput type="date" label="Created to" value={filters.to} onChange={(event) => updateFilter("to", event.currentTarget.value)} />
        </SimpleGrid>
        </Collapse>
        <Group justify="space-between">
          <Text size="sm" c="dimmed" role="status">{filtered.length} of {orders.data.length} orders</Text>
          <Button variant="subtle" onClick={clearFilters}>Clear filters</Button>
        </Group>
      </Stack>
      <DataTable
        label="Purchase orders"
        rows={filtered}
        rowKey={(po) => po.id}
        to={(po) => `/orders/${po.id}`}
        selectable={{ filename: "orders-selected.csv", csv: (po) => ({ Order: po.number, Vendor: po.vendor?.name, Created: formatDate(po.createdAt), By: po.createdBy, Billing: po.billingStatus, Payment: po.paymentStatus, Receiving: po.receivingStatus, Total: ((po.totalEstimateCents ?? 0) / 100).toFixed(2) }) }}
        empty={orders.data.length ? "No orders match these filters" : "No orders yet. Create one, or let the dock open one by scanning a surprise delivery."}
        columns={[
          { key: "number", label: "Order", width: 130, primary: true, strong: true, render: (po) => po.number },
          { key: "vendor", label: "Vendor", render: (po) => po.vendor?.name ?? "Vendor not set" },
          { key: "date", label: "Created", width: 120, render: (po) => formatDate(po.createdAt) },
          { key: "by", label: "By", width: 110, render: (po) => (po.source === "SCAN" ? "Dock" : po.createdBy) },
          { key: "billing", label: "Billing", width: 120, render: (po) => <StatusBadge status={po.billingStatus} /> },
          { key: "payment", label: "Payment", width: 110, render: (po) => <StatusBadge status={po.paymentStatus} /> },
          { key: "receiving", label: "Receiving", width: 190, render: (po) => <ReceivingBadge status={po.receivingStatus} held={po.heldUnits ?? po.lines.reduce((s, l) => s + l.qtyHeld, 0)} /> },
          { key: "total", label: "Total", width: 120, align: "right", strong: true, render: (po) => <Money cents={po.totalEstimateCents} /> },
        ]}
        phone={(po) => ({
          title: `${po.number} · ${po.vendor?.name ?? "Vendor not set"}`,
          meta: (
            <Stack gap={6} mt={4}>
              <span>
                {po.source === "SCAN" ? "Opened at the dock" : `By ${po.createdBy}`} · {formatDate(po.createdAt)}
                {po.lifecycle !== "OPEN" ? ` · ${po.lifecycle.toLowerCase()}` : ""}
              </span>
              <Axes po={po} />
            </Stack>
          ),
          aside: <Text fw={600}><Money cents={po.totalEstimateCents} /></Text>,
        })}
      />
    </>
  );
}

export function NewOrder() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const vendors = useQuery({ queryKey: ["vendors", "SUPPLIER"], queryFn: () => get<Vendor[]>("/vendors?kind=SUPPLIER") });
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ itemId: null as string | null, qty: 1, cost: 0 }]);
  const total = lines.reduce((s, l) => s + l.qty * Math.round(l.cost * 100), 0);
  const save = async () => {
    try {
      const po = await post<PurchaseOrder>("/purchase-orders", {
        vendorId: Number(vendorId),
        warehouseId: Number(warehouseId ?? warehouses.data?.[0]?.id),
        notes: notes || undefined,
        lines: lines.map((l) => ({ itemId: Number(l.itemId), qtyOrdered: l.qty, unitCostCents: Math.round(l.cost * 100) })),
      });
      toastOk(`${po.number} created`);
      await queryClient.invalidateQueries();
      navigate(`/orders/${po.id}`);
    } catch (error) {
      toastErr(error);
    }
  };
  const pickItem = (i: number, value: string | null) => {
    const item = items.data?.find((x) => String(x.id) === value);
    setLines(lines.map((l, j) => (j === i ? { ...l, itemId: value, cost: item ? item.lastCostCents / 100 : l.cost } : l)));
  };
  return (
    <Stack gap="lg">
      <PageHeader back={{ to: "/orders", label: "Orders" }} title="New purchase order" />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label="Vendor" data={(vendors.data ?? []).map((v) => ({ value: String(v.id), label: v.name }))} value={vendorId} onChange={setVendorId} searchable />
        <Select label="Deliver to" data={(warehouses.data ?? []).map((w) => ({ value: String(w.id), label: w.name }))} value={warehouseId ?? (warehouses.data?.[0] ? String(warehouses.data[0].id) : null)} onChange={setWarehouseId} />
      </SimpleGrid>
      {lines.map((line, i) => (
        <Group key={i} align="flex-end" wrap="nowrap">
          <Select label={i === 0 ? "Item" : undefined} data={(items.data ?? []).filter((it) => !it.isBundle).map((it) => ({ value: String(it.id), label: `${it.sku} · ${it.name}` }))} value={line.itemId} onChange={(v) => pickItem(i, v)} searchable style={{ flex: 2 }} />
          <NumberInput label={i === 0 ? "Qty" : undefined} value={line.qty} min={1} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, qty: Number(v) || 1 } : l)))} w={80} />
          <NumberInput label={i === 0 ? "Unit $" : undefined} value={line.cost} min={0} decimalScale={2} onChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, cost: Number(v) || 0 } : l)))} w={110} />
          <ActionIcon variant="subtle" color="red" size="lg" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1} aria-label="Remove line">
            <IconTrash size={18} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button variant="light" onClick={() => setLines([...lines, { itemId: null, qty: 1, cost: 0 }])}>
          Add line
        </Button>
      </Group>
      <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize />
      <Group justify="space-between">
        <Text fw={600}>Estimated {usd(total)}</Text>
        <Button size="md" onClick={save} disabled={!vendorId || lines.some((l) => !l.itemId)}>
          Create order
        </Button>
      </Group>
    </Stack>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const po = useQuery({ queryKey: ["order", id], queryFn: () => get<PurchaseOrder & { bills: { id: number; number: string; status: string; kind: string; totalCents: number }[]; receipts: { id: number; number: string; state: string; receivedAt: string; receivedBy: string }[]; warehouse: Warehouse }>(`/purchase-orders/${id}`) });
  if (!po.data) return <Loading />;
  const p = po.data;
  const draftBill = async () => {
    try {
      const bill = await post<{ id: number }>("/bills", { poId: p.id });
      await queryClient.invalidateQueries();
      navigate(`/bills/${bill.id}`);
    } catch (error) {
      toastErr(error);
    }
  };
  const unbilled = p.lines.some((l) => l.qtyOrdered > l.qtyBilled) && !p.bills.some((b) => b.status === "DRAFT");
  return (
    <Stack gap="lg">
      <PageHeader back={{ to: "/orders", label: "Orders" }} title={p.number} subtitle={`${p.vendor?.name ?? "Vendor not set"} · to ${p.warehouse.name} · ${p.source === "SCAN" ? "opened at the dock" : `by ${p.createdBy}`}`} action={<Axes po={p} />} />
      {p.notes ? <Text c="dimmed">{p.notes}</Text> : null}
      <Card withBorder>
        <Table.ScrollContainer minWidth={560}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item</Table.Th>
                <Table.Th ta="right">Ordered</Table.Th>
                <Table.Th ta="right">Received</Table.Th>
                <Table.Th ta="right">Awaiting bill</Table.Th>
                <Table.Th ta="right">Billed</Table.Th>
                <Table.Th ta="right">Unit</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {p.lines.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>
                    {l.item?.name}
                    {l.addedAtDock ? (
                      <Text span size="xs" c="dimmed">
                        {" "}
                        · added at the dock
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td ta="right">{l.qtyOrdered}</Table.Td>
                  <Table.Td ta="right">{l.qtyReceived}</Table.Td>
                  <Table.Td ta="right" c={l.qtyHeld ? "var(--warn-fg)" : undefined}>
                    {l.qtyHeld || ""}
                  </Table.Td>
                  <Table.Td ta="right">{l.qtyBilled}</Table.Td>
                  <Table.Td ta="right">{usd(l.unitCostCents)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder>
          <Title order={3} mb="xs">
            Bills
          </Title>
          {p.bills.filter((b) => b.kind === "INVENTORY").map((b) => (
            <Group key={b.id} justify="space-between">
              <Anchor component={Link} to={`/bills/${b.id}`}>
                {b.number}
              </Anchor>
              <Group gap="xs">
                <Money cents={b.totalCents} />
                <StatusBadge status={b.status} />
              </Group>
            </Group>
          ))}
          {unbilled ? (
            <Button mt="sm" variant="light" onClick={draftBill}>
              Enter the vendor's bill
            </Button>
          ) : null}
        </Card>
        <Card withBorder>
          <Title order={3} mb="xs">
            Warehouse receipts
          </Title>
          {p.receipts.length === 0 ? <Text c="dimmed">Nothing received yet.</Text> : null}
          {p.receipts.map((r) => (
            <Group key={r.id} justify="space-between">
              <Anchor component={Link} to={`/receipts/${r.id}`}>
                {r.number} · {formatDate(r.receivedAt)} · {r.receivedBy}
              </Anchor>
              <StatusBadge status={r.state} />
            </Group>
          ))}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
