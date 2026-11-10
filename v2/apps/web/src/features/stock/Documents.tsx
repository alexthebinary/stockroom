import { Anchor, Badge, Button, Group, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { get } from "../../lib/api";
import { formatDate, Loading, Money, PageHeader, Problem, plural } from "../../components/ui";

type Named = { id: number; sku: string; name: string } | null;
type Receipt = {
  id: number; number: string; state: string; receivedAt: string; receivedBy: string; notes: string | null;
  po: { id: number; number: string };
  vendor: { id: number; name: string } | null;
  warehouse: { id: number; name: string; code: string } | null;
  lines: { id: number; qty: number; landedQty: number; valueCents: number; item: Named }[];
};
type Adjustment = {
  number: string; type: string; date: string; actor: string; qty: number;
  lines: { id: number; qty: number; valueCents: number | null; item: Named; warehouse: { id: number; name: string; code: string } | null }[];
};

const BackToStock = ({ tab }: { tab: string }) => (
  <Button component={Link} to={`/items?tab=${tab}`} variant="subtle" size="compact-sm" mb="xs" style={{ alignSelf: "flex-start" }}>
    ← Back to Stock
  </Button>
);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <Text fw={600}>{children}</Text>
    </div>
  );
}

/** A warehouse receipt (WH-IN): what physically arrived, against which order. */
export function ReceiptDetail() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["receipt", id], queryFn: () => get<Receipt>(`/receipts/${id}`) });
  if (q.error) return <Problem error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const units = r.lines.reduce((n, l) => n + l.qty, 0);
  return (
    <Stack gap="lg">
      <BackToStock tab="receipts" />
      <PageHeader
        title={r.number}
        subtitle={`Received ${formatDate(r.receivedAt)} by ${r.receivedBy}`}
        action={<Badge variant="light" color="gray">{r.state.replace(/_/g, " ").toLowerCase()}</Badge>}
      />
      <Group gap="xl" align="flex-start">
        <Fact label="Order"><Anchor component={Link} to={`/orders/${r.po.id}`} fw={600}>{r.po.number}</Anchor></Fact>
        <Fact label="Vendor">{r.vendor?.name ?? "Vendor not set"}</Fact>
        <Fact label="Warehouse">{r.warehouse ? `${r.warehouse.name} (${r.warehouse.code})` : "—"}</Fact>
        <Fact label="Units">{plural(units, "unit")}</Fact>
      </Group>
      {r.notes ? <Text c="dimmed">{r.notes}</Text> : null}
      <Table.ScrollContainer minWidth={420} type="native">
        <Table>
          <Table.Thead>
            <Table.Tr><Table.Th>Item</Table.Th><Table.Th ta="right">Counted</Table.Th><Table.Th ta="right">Value</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {r.lines.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>{l.item?.name ?? "Unknown item"}<Text size="xs" c="dimmed">{l.item?.sku}</Text></Table.Td>
                <Table.Td ta="right">{l.qty}</Table.Td>
                <Table.Td ta="right">{l.valueCents ? <Money cents={l.valueCents} /> : <Text span c="dimmed">awaiting bill</Text>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

/** A stock adjustment or opening stock (ADJ): every item line it moved. */
export function AdjustmentDetail() {
  const { number } = useParams();
  const q = useQuery({ queryKey: ["adjustment", number], queryFn: () => get<Adjustment>(`/other-transactions/${encodeURIComponent(number ?? "")}`) });
  if (q.error) return <Problem error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const a = q.data;
  return (
    <Stack gap="lg">
      <BackToStock tab="adjustments" />
      <PageHeader title={a.number} subtitle={`${a.type} · ${formatDate(a.date)} · ${a.actor}`} />
      <Group gap="xl" align="flex-start">
        <Fact label="Type">{a.type}</Fact>
        <Fact label="Net change">{a.qty > 0 ? "+" : ""}{plural(a.qty, "unit")}</Fact>
        <Fact label="Lines">{a.lines.length}</Fact>
      </Group>
      <Table.ScrollContainer minWidth={420} type="native">
        <Table>
          <Table.Thead>
            <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Warehouse</Table.Th><Table.Th ta="right">Change</Table.Th><Table.Th ta="right">Value</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {a.lines.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>{l.item?.name ?? "Unknown item"}<Text size="xs" c="dimmed">{l.item?.sku}</Text></Table.Td>
                <Table.Td>{l.warehouse?.name ?? "—"}</Table.Td>
                <Table.Td ta="right">{l.qty > 0 ? "+" : ""}{l.qty}</Table.Td>
                <Table.Td ta="right">{l.valueCents != null ? <Money cents={l.valueCents} /> : "—"}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
