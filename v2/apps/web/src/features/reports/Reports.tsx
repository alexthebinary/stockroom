import { Alert, Card, Group, Stack, Table, Tabs, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { plural, formatDate, Loading, Money, PageHeader, usd } from "../../components/ui";
import { get } from "../../lib/api";

type Books = { sound: boolean; problems: string[]; figures: Record<string, number> };
type Tb = { rows: { id: number; code: string; name: string; isHeader: boolean; parentId: number | null; debitCents: number; creditCents: number }[]; totalDebitCents: number; totalCreditCents: number };
type Valuation = { rows: { itemId: number; sku: string; name: string; onHand: number; held: number; valueCents: number; averageCents: number; glCents: number; varianceCents: number }[]; totalValueCents: number; totalGlCents: number };
type Held = { poId: number; poNumber: string; vendor: { name: string } | null; item: { name: string }; qtyHeld: number; estimateCents: number; receivedAt: string; days: number }[];

export function Reports() {
  return (
    <>
      <PageHeader title="Reports" />
      <Tabs defaultValue="books">
        <Tabs.List mb="md">
          <Tabs.Tab value="books">Books check</Tabs.Tab>
          <Tabs.Tab value="tb">Trial balance</Tabs.Tab>
          <Tabs.Tab value="stock">Stock value</Tabs.Tab>
          <Tabs.Tab value="held">Awaiting bill</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="books">
          <BooksCheck />
        </Tabs.Panel>
        <Tabs.Panel value="tb">
          <TrialBalance />
        </Tabs.Panel>
        <Tabs.Panel value="stock">
          <StockValue />
        </Tabs.Panel>
        <Tabs.Panel value="held">
          <HeldStock />
        </Tabs.Panel>
      </Tabs>
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
