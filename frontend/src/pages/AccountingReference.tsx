/**
 * The chart of accounts and its transaction journal entries, in the layout of
 * the client's reference sheet (2026-09-24) but filled with THIS company's
 * ledger: every account and balance, and for every posting rule the entries it
 * has actually made. Nothing here is sample data; a rule that has not posted
 * yet says so instead of showing an illustrative amount.
 */
import { Anchor, Card, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api, type TrialBalance } from "../api";
import { QueryState, formatDate, money } from "../components/ui";

type Account = { code: string; name: string; accountType: string; normalSide: string; isActive: boolean };
type Line = { code: string; name: string; debitCents: number; creditCents: number };
type Example = {
  transactionType: string;
  description: string;
  debit: { code: string; name: string };
  credit: { code: string; name: string };
  postedCount: number;
  latest: { id: number; entryNumber: string; entryDate: string; memo: string | null; lines: Line[] } | null;
};

/** What each account holds in this app, in plain words. */
const ACCOUNT_NOTES: Record<string, string> = {
  "1000": "Cash and bank: customer payments in, supplier payments and refunds out.",
  "1100": "What customers owe on invoices not yet paid, less anything paid ahead at checkout.",
  "1200": "Stock on the shelves at FIFO cost. Equals the stock valuation report.",
  "1210": "Goods billed by a supplier but not yet received into stock.",
  "1220": "Goods shipped whose cost is not yet matched to an invoice.",
  "1230": "Retired: transfers no longer post. Holds only transfers despatched before the change until they arrive.",
  "2000": "What we owe suppliers on bills not yet paid.",
  "2100": "Retired: checkout payments now go to Accounts Receivable. Holds only older deposits until their orders ship.",
  "3000": "The other side of the opening stock position when the books were set up.",
  "4000": "Sales at invoice value, less credit notes for returns.",
  "4100": "Stock found on a count or adjustment, at cost.",
  "5000": "The cost of the goods sold, matched to each invoice.",
  "5100": "Stock written off as damaged, lost or short, at cost.",
  "5200": "Cent differences when a landed cost does not divide evenly across units.",
  "5300": "Parts used on repairs. No screen posts to it yet.",
  "5400": "Replacement units given under warranty. No screen posts to it yet.",
};

const TYPE_LABEL: Record<string, string> = {
  ASSET: "Current Assets",
  LIABILITY: "Current Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

/** The transactions in the order the business meets them, with plain titles. */
const PROCESSES: { area: string; items: { type: string; title: string }[] }[] = [
  {
    area: "Purchasing",
    items: [
      { type: "PURCHASE_BILL", title: "Bill (vendor invoice)" },
      { type: "PURCHASE_PAYMENT", title: "Bill payment" },
      { type: "GOODS_RECEIPT", title: "Goods receipt (into stock)" },
    ],
  },
  {
    area: "Sales",
    items: [
      { type: "CUSTOMER_DEPOSIT", title: "Checkout payment (before shipping)" },
      { type: "GOODS_ISSUE", title: "Goods issue (shipment leaves stock)" },
      { type: "SALES_INVOICE", title: "Invoice – revenue" },
      { type: "INVOICE_COGS", title: "Invoice – cost of goods sold" },
      { type: "SALES_PAYMENT", title: "Customer payment" },
    ],
  },
  {
    area: "Returns",
    items: [
      { type: "SALES_RETURN", title: "Return – credit note" },
      { type: "RETURN_RESTOCK", title: "Return – back into stock" },
      { type: "CUSTOMER_REFUND", title: "Refund" },
    ],
  },
  {
    area: "Inventory",
    items: [
      { type: "OPENING_BALANCE", title: "Opening balance" },
      { type: "ADJUSTMENT_INCREASE", title: "Adjustment – stock found" },
      { type: "ADJUSTMENT_DECREASE", title: "Adjustment – stock written off" },
    ],
  },
];

/** Rules nothing posts to today: shown only once they have entries. */
const DORMANT_TITLE: Record<string, string> = {
  REPAIR_PARTS_CONSUMPTION: "Repair parts used",
  WARRANTY_REPLACEMENT: "Warranty replacement",
  SALES_SHIPMENT_COGS: "Cost of goods sold on shipment (earlier method)",
  DEPOSIT_APPLIED: "Deposit applied to the invoice (earlier method)",
  INVENTORY_TRANSFER: "Transfer out, into transit (earlier method)",
  INVENTORY_TRANSFER_IN: "Transfer in, out of transit (earlier method)",
};

export function ChartOfAccounts() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ data: Account[] }>("/accounts") });
  const trial = useQuery({ queryKey: ["trial-balance"], queryFn: () => api.get<TrialBalance>("/trial-balance") });
  const balance = (code: string) => trial.data?.accounts.find((a) => a.code === code)?.balanceCents ?? 0;
  const groups = Object.keys(TYPE_LABEL)
    // A retired account stays visible only while it still holds a balance.
    .map((type) => ({
      type,
      rows: (accounts.data?.data ?? []).filter((a) => a.accountType === type && (a.isActive || balance(a.code) !== 0)),
    }))
    .filter((g) => g.rows.length > 0);

  return (
    <QueryState isLoading={accounts.isLoading} error={accounts.error} onRetry={accounts.refetch}>
      <Text size="sm" c="dimmed" mb="sm">
        Every account in the ledger, what it holds, and its balance today.
      </Text>
      <Card withBorder radius="md" p={0}>
        <Table.ScrollContainer minWidth={720}>
          <Table className="data-grid" verticalSpacing={8}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={70}>Code</Table.Th>
                <Table.Th>Account</Table.Th>
                <Table.Th w={150}>Type</Table.Th>
                <Table.Th w={90}>Normal</Table.Th>
                <Table.Th>What it holds</Table.Th>
                <Table.Th ta="right" w={130}>Balance</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.map((g) => (
                <GroupRows key={g.type} label={TYPE_LABEL[g.type]} rows={g.rows} balance={balance} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </QueryState>
  );
}

function GroupRows({ label, rows, balance }: { label: string; rows: Account[]; balance: (code: string) => number }) {
  return (
    <>
      <Table.Tr>
        <Table.Td colSpan={6} className="coa-group">
          {label}
        </Table.Td>
      </Table.Tr>
      {rows.map((a) => (
        <Table.Tr key={a.code}>
          <Table.Td fw={600}>{a.code}</Table.Td>
          <Table.Td>
            <Text size="sm" fw={500}>{a.name}</Text>
          </Table.Td>
          <Table.Td>
            <Text size="sm">{a.code === "5000" ? "Expenses (COGS)" : label}</Text>
          </Table.Td>
          <Table.Td>
            <Text size="sm">{a.normalSide === "DEBIT" ? "Debit" : "Credit"}</Text>
          </Table.Td>
          <Table.Td>
            <Text size="sm">{ACCOUNT_NOTES[a.code] ?? ""}</Text>
          </Table.Td>
          <Table.Td ta="right">{money(balance(a.code))}</Table.Td>
        </Table.Tr>
      ))}
    </>
  );
}

export function TransactionEntries({ onShowEntries }: { onShowEntries: (transactionType: string) => void }) {
  const examples = useQuery({
    queryKey: ["journal-examples"],
    queryFn: () => api.get<{ data: Example[] }>("/journal-examples"),
  });
  const byType = (t: string) => examples.data?.data.find((r) => r.transactionType === t);
  const dormant = (examples.data?.data ?? []).filter((e) => e.transactionType in DORMANT_TITLE && e.postedCount > 0);

  return (
    <QueryState isLoading={examples.isLoading} error={examples.error} onRetry={examples.refetch}>
      <Text size="sm" c="dimmed" mb="md">
        What each kind of transaction posts, with the latest real entry from this ledger. Nobody types these: they post
        themselves when the work is done in the app.
      </Text>
      <Stack gap="xl">
        {PROCESSES.map((section) => (
          <div key={section.area}>
            <Title order={2} size="h4" mb="sm">
              {section.area}
            </Title>
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
              {section.items.map((item) => (
                <EntryCard key={item.type} title={item.title} example={byType(item.type)} onShowEntries={onShowEntries} />
              ))}
            </SimpleGrid>
          </div>
        ))}
        {dormant.length > 0 && (
          <div>
            <Title order={2} size="h4" mb={4}>
              Earlier methods
            </Title>
            <Text size="sm" c="dimmed" mb="sm">
              Rules the app no longer uses. Their past entries stay on the books as they were posted. Transfers between
              warehouses now post nothing: the stock stays in Inventory at its cost.
            </Text>
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
              {dormant.map((e) => (
                <EntryCard
                  key={e.transactionType}
                  title={DORMANT_TITLE[e.transactionType]}
                  example={e}
                  onShowEntries={onShowEntries}
                />
              ))}
            </SimpleGrid>
          </div>
        )}
      </Stack>
    </QueryState>
  );
}

function EntryCard({
  title,
  example,
  onShowEntries,
}: {
  title: string;
  example?: Example;
  onShowEntries: (transactionType: string) => void;
}) {
  if (!example) return null;
  const e = example.latest;
  // The latest entry's own lines when there is one (it may carry more than two,
  // e.g. a rounding line); otherwise the rule's two sides, without amounts.
  const rows: { side: "Dr" | "Cr"; code: string; name: string; cents?: number }[] = e
    ? e.lines.map((l) => ({
        side: l.debitCents > 0 ? "Dr" : "Cr",
        code: l.code,
        name: l.name,
        cents: l.debitCents || l.creditCents,
      }))
    : [
        { side: "Dr", ...example.debit },
        { side: "Cr", ...example.credit },
      ];

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb={4}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {example.postedCount === 0
            ? "no entries yet"
            : `${example.postedCount} ${example.postedCount === 1 ? "entry" : "entries"}`}
        </Text>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {example.description}
      </Text>
      <Table verticalSpacing={4} className="rule-table">
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>
              <Table.Td w={36} fw={600}>
                {r.side}
              </Table.Td>
              <Table.Td>
                {r.code} {r.name}
              </Table.Td>
              {e && <Table.Td ta="right">{money(r.cents ?? 0)}</Table.Td>}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {e ? (
        <>
          <Text size="xs" c="dimmed" mt="xs">
            Latest: {e.entryNumber} · {formatDate(e.entryDate)}
            {e.memo ? ` · ${e.memo}` : ""}
          </Text>
          <Anchor
            component="button"
            type="button"
            size="sm"
            mt={6}
            style={{ alignSelf: "flex-start" }}
            onClick={() => onShowEntries(example.transactionType)}
          >
            {example.postedCount === 1 ? "Show this entry" : `Show all ${example.postedCount}`}
          </Anchor>
        </>
      ) : (
        <Text size="xs" c="dimmed" mt="xs">
          Posts automatically the first time this happens in the app.
        </Text>
      )}
    </Card>
  );
}
