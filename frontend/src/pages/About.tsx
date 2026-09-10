import {
  Alert,
  Anchor,
  Badge,
  Card,
  Code,
  Grid,
  Group,
  List,
  SimpleGrid,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  api,
  type Account,
  type SystemMeta,
  type TrialBalance,
  type ValuationReport,
} from "../api";
import { PurchaseFlow, SalesFlow, TransferFlow } from "../components/FlowDiagram";
import { PageHeader, QueryState, StatusBadge, money } from "../components/ui";

type Template = {
  id: number;
  transactionType: string;
  description: string;
  debitAccountName: string;
  creditAccountName: string;
};

/** Every physical stock change, and what it does. Mirrors the API contract. */
const MOVEMENT_EFFECTS: [string, string, string][] = [
  ["PURCHASE_RECEIPT", "Goods arrive from a vendor", "on hand ↑, incoming ↓, a cost layer is created"],
  ["SALE_SHIP", "Goods leave for a customer", "on hand ↓, reserved ↓, layers consumed, COGS booked"],
  ["TRANSFER_OUT", "Goods leave the source warehouse", "source on hand ↓, layers consumed"],
  ["TRANSFER_IN", "Goods arrive at the destination", "destination on hand ↑, layers rebuilt at original cost and age"],
  ["ADJUSTMENT_IN", "Stock written on", "on hand ↑, a layer is created at the cost given"],
  ["ADJUSTMENT_OUT", "Stock written off", "on hand ↓, layers consumed at their real cost"],
];

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="md" mb="md">
      <Title order={4} mb={subtitle ? 2 : "sm"}>
        {title}
      </Title>
      {subtitle && (
        <Text size="sm" c="dimmed" mb="sm">
          {subtitle}
        </Text>
      )}
      {children}
    </Card>
  );
}

export default function About() {
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: () => api.get<SystemMeta>("/meta"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api.get<{ data: Account[] }>("/accounts"),
  });
  const templates = useQuery({
    queryKey: ["journal-templates"],
    queryFn: () => api.get<{ data: Template[] }>("/journal-templates"),
  });
  const trial = useQuery({
    queryKey: ["trial-balance"],
    queryFn: () => api.get<TrialBalance>("/trial-balance"),
  });
  const valuation = useQuery({
    queryKey: ["report-valuation"],
    queryFn: () => api.get<ValuationReport>("/reports/inventory-valuation"),
  });

  const listed = meta.data?.groups.reduce((s, g) => s + g.entities.length, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="About this system"
        subtitle="How the schema is shaped, and the rules the data actually obeys."
      />

      <Alert icon={<IconInfoCircle size={18} />} mb="md" color="gray">
        <Text size="sm">
          Every figure on this page is read from the running database, not written into the
          documentation — so it cannot drift from the system it describes.{" "}
          {meta.data && (
            <>
              This instance is backed by <strong>{meta.data.database}</strong>, and all{" "}
              <strong>
                {listed} of {meta.data.tableCount} tables
              </strong>{" "}
              are described below.
            </>
          )}
        </Text>
      </Alert>

      <Section
        title="What this is"
        subtitle="A single-tenant warehouse management demo, built to a scope whose first principles are double-entry bookkeeping and FIFO costing."
      >
        <Text size="sm">
          Stock is tracked by quantity <em>and</em> by cost. Every physical movement writes an
          immutable audit row, and every financial event writes a balanced journal entry. Those
          two records are independent derivations of the same reality, which is what lets the{" "}
          <Anchor component={Link} to="/reports">
            valuation report
          </Anchor>{" "}
          check one against the other.
        </Text>
      </Section>

      <Section
        title="The three rules that shape everything else"
        subtitle="Most of the schema's oddities follow from these."
      >
        <List spacing="sm" size="sm">
          <List.Item>
            <strong>Money is an integer number of cents.</strong> No floating point touches a
            money path anywhere. A ledger that does not balance to the cent is worthless, and
            floats cannot represent money exactly.
          </List.Item>
          <List.Item>
            <strong>
              <Code>availableQty</Code> is never stored.
            </strong>{" "}
            It is computed as <Code>onHandQty − reservedQty</Code> at the moment of reading. A
            stored copy is a second source of truth waiting to disagree with the first.
          </List.Item>
          <List.Item>
            <strong>Nothing posted is ever deleted.</strong> Catalog records in use are archived;
            a posted journal entry is reversed by a mirror-image contra entry, so the trail shows
            both what happened and that it was undone.
          </List.Item>
        </List>
      </Section>

      <Section
        title="Entities, by the job they do"
        subtitle="Row counts are live."
      >
        <QueryState isLoading={meta.isLoading} error={meta.error} onRetry={meta.refetch}>
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {meta.data?.groups.map((group) => (
              <Card key={group.name} withBorder radius="sm" p="sm" bg="var(--surface-sunken)">
                <Group justify="space-between" mb={4}>
                  <Text fw={700} size="sm">
                    {group.name}
                  </Text>
                  <Badge variant="light" color="gray" radius="sm">
                    {group.entities.length}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" mb="xs">
                  {group.blurb}
                </Text>
                <Table verticalSpacing={4}>
                  <Table.Tbody>
                    {group.entities.map((e) => (
                      <Table.Tr key={e.name}>
                        <Table.Td style={{ width: "34%" }}>
                          <Code>{e.name}</Code>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {e.note ?? "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right" style={{ width: "14%" }}>
                          <Text size="xs" fw={600}>
                            {e.rows.toLocaleString()}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            ))}
          </SimpleGrid>
        </QueryState>
      </Section>

      <Section
        title="How a document moves through the system"
        subtitle="Stock effects in grey, ledger postings in blue. Each step is its own document, not a side effect of a status change."
      >
        <SalesFlow />
        <div style={{ height: 18 }} />
        <PurchaseFlow />
        <div style={{ height: 18 }} />
        <TransferFlow />
        <Text size="xs" c="dimmed" mt="sm">
          Note what is <em>not</em> a movement: reserving stock and booking incoming stock change
          availability but move no goods, so they write no audit row and post nothing. The six
          movement types below are the complete set.
        </Text>
      </Section>

      <Section title="The six physical movements" subtitle="Everything that can change stock, and its full effect.">
        <Table.ScrollContainer minWidth={720}>
          <Table className="data-grid" verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>When</Table.Th>
                <Table.Th>Effect</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {MOVEMENT_EFFECTS.map(([type, when, effect]) => (
                <Table.Tr key={type}>
                  <Table.Td>
                    <StatusBadge value={type} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{when}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {effect}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Section
            title="FIFO costing"
            subtitle="Why cost layers exist instead of an average cost field."
          >
            <Text size="sm" mb="sm">
              A single average-cost number cannot answer “what did the units we just shipped
              cost?”. Each receipt creates an <Code>InventoryLot</Code> with a unit cost and a
              remaining quantity. Each issue consumes the <strong>oldest layer first</strong> and
              writes <Code>LotConsumption</Code> rows recording exactly which layers it drew from.
            </Text>
            <Card withBorder radius="sm" p="sm" bg="var(--surface-sunken)" mb="sm">
              <Text size="xs" fw={700} mb={4}>
                Worked example
              </Text>
              <Text size="xs" c="dimmed">
                480 units at $2.05 arrive, then 100 at $3.00. A sale of 60 consumes the $2.05
                layer first, so COGS is 60 × $2.05 = <strong>$123.00</strong> — not
                60 × the $2.21 blended average. The $3.00 layer is untouched and stays whole for
                the next sale.
              </Text>
            </Card>
            <Text size="sm">
              A transfer preserves both the unit cost <em>and</em> the original receipt date, so
              old stock does not become artificially young and jump the queue at its new
              warehouse. See the live layers on any{" "}
              <Anchor component={Link} to="/products">
                product page
              </Anchor>
              .
            </Text>
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Section
            title="Double entry"
            subtitle="Every financial event, as a balanced pair."
          >
            <Text size="sm" mb="sm">
              A journal entry is refused unless each line is one-sided and total debits equal
              total credits to the cent. Postings are configuration, not code — the pairs below
              are rows in <Code>JournalTemplate</Code>.
            </Text>
            <QueryState
              isLoading={templates.isLoading}
              error={templates.error}
              onRetry={templates.refetch}
            >
              <Table.ScrollContainer minWidth={420}>
                <Table className="data-grid" verticalSpacing={4}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Event</Table.Th>
                      <Table.Th>Debit</Table.Th>
                      <Table.Th>Credit</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {templates.data?.data.map((t) => (
                      <Table.Tr key={t.id}>
                        <Table.Td>
                          <Text size="xs">{t.description}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{t.debitAccountName}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{t.creditAccountName}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </QueryState>
          </Section>
        </Grid.Col>
      </Grid>

      <Section
        title="Chart of accounts"
        subtitle="Read live from the database."
      >
        <QueryState isLoading={accounts.isLoading} error={accounts.error} onRetry={accounts.refetch}>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
            {accounts.data?.data.map((a) => (
              <Card key={a.code} withBorder radius="sm" p="xs">
                <Text size="xs" c="dimmed">
                  {a.code}
                </Text>
                <Text size="sm" fw={600}>
                  {a.name}
                </Text>
                <Text size="xs" c="dimmed" tt="lowercase">
                  {a.accountType} · normally {a.normalSide.toLowerCase()}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        </QueryState>
      </Section>

      <Section
        title="What is actually checked, and what only looks checked"
        subtitle="Worth being precise about, because one of these is a tautology."
      >
        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Text size="sm" fw={700} mb={4}>
              Not a real check
            </Text>
            <Text size="sm" c="dimmed">
              Summing every debit against every credit. Because the ledger engine refuses an
              unbalanced entry, the sum of balanced entries balances by construction — it can
              never report a problem no matter how wrong the books are.
            </Text>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Text size="sm" fw={700} mb={4}>
              Checks that can genuinely fail
            </Text>
            <List size="sm" spacing={4}>
              <List.Item>
                Each entry re-proved on its own — catches anything that wrote journal lines
                around the engine.
                {trial.data && (
                  <Text span size="xs" c="dimmed">
                    {" "}
                    (currently {trial.data.unbalancedEntries.length} unbalanced)
                  </Text>
                )}
              </List.Item>
              <List.Item>
                The accounting equation — catches entries that balance internally but post to the
                wrong side.
                {trial.data && (
                  <Text span size="xs" c="dimmed">
                    {" "}
                    (variance {money(trial.data.equationVarianceCents)})
                  </Text>
                )}
              </List.Item>
              <List.Item>
                Cost layers summed against the Inventory account — two independent paths to one
                number.
                {valuation.data && (
                  <Text span size="xs" c="dimmed">
                    {" "}
                    (variance {money(valuation.data.varianceCents)})
                  </Text>
                )}
              </List.Item>
            </List>
          </Grid.Col>
        </Grid>
      </Section>

      <Section
        title="Guarantees the API enforces"
        subtitle="Attempting any of these returns a clear error rather than a corrupted record."
      >
        <List spacing={6} size="sm">
          <List.Item>Stock can never go below zero.</List.Item>
          <List.Item>
            Stock reserved for a packed order cannot be taken by a transfer or written off —
            only the shipment that owns the reservation may consume it.
          </List.Item>
          <List.Item>
            Reserving or shipping more than is available fails, naming the SKU, the warehouse and
            the shortfall.
          </List.Item>
          <List.Item>
            A double-clicked action cannot process twice — every status transition is claimed
            atomically, and the loser gets a conflict.
          </List.Item>
          <List.Item>
            A balance write is conditional on the values it was calculated from, so a concurrent
            change is rejected rather than applied to stale numbers.
          </List.Item>
          <List.Item>
            An invoiced order cannot be cancelled and a posted bill cannot be abandoned — the
            document must be voided, which reverses its posting.
          </List.Item>
          <List.Item>
            A posted entry cannot be unposted while anything depends on it, such as a payment
            made against its bill.
          </List.Item>
        </List>
      </Section>

      <Section
        title="Deliberately out of scope"
        subtitle="Absent by choice, not oversight."
      >
        <Text size="sm" c="dimmed">
          No marketplace or carrier integrations. No bin or shelf locations — stock is held at
          warehouse level. No multi-currency, no tax engine beyond a per-order figure, no
          forecasting or reorder automation, and no real authentication: the sign-in page is a
          formality and every API route behind it is open. This is a demo, and it should not hold
          real data.
        </Text>
      </Section>
    </>
  );
}
