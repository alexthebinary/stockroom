/**
 * The client's own "Chart of Accounts & Transaction Journal Entries" sheet
 * (three pages, adopted 2026-09-24), rendered from the LIVE chart and posting
 * rules rather than copied as a picture: if a rule in the app ever drifts from
 * the sheet, this page shows the app's rule, not the sheet's wish.
 *
 * Text in SHEET_* is the sheet's own wording. Anything the app added beyond the
 * sheet is marked as such, with the reason, so an accountant can see at a
 * glance which parts are theirs.
 */
import { Anchor, Badge, Card, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api, type TrialBalance } from "../api";
import { QueryState, money } from "../components/ui";

type Account = { code: string; name: string; accountType: string; normalSide: string; isActive: boolean };
type Rule = {
  transactionType: string;
  description: string;
  debitAccountCode: string;
  creditAccountCode: string;
  debitAccountName: string;
  creditAccountName: string;
};

/** Sheet section 1, "Description / Notes", verbatim. */
const SHEET_NOTES: Record<string, string> = {
  "1000": "Cash and bank accounts used for payments and receipts.",
  "1100": "Amounts owed by customers from sales on credit.",
  "1200": "Stock of goods available for sale (on-hand inventory).",
  "1210": "Temporary clearing account for goods received / purchase receipts pending put-away.",
  "1220": "Temporary clearing account for goods issued / sales shipments pending relief of inventory.",
  "2000": "Amounts owed to vendors for purchases on credit (bills).",
  "3000": "Used to record opening balances (e.g., starting inventory) when books are first set up.",
  "4000": "Revenue from sale of goods to customers.",
  "4100": "Gain arising from positive inventory count adjustments (found stock / overage).",
  "5000": "Cost of inventory sold to customers (matched to sales).",
  "5100": "Loss from negative inventory count adjustments (shrinkage / shortage).",
};

/** Accounts the app needs that the sheet does not list, and why. */
const APP_NOTES: Record<string, string> = {
  "1230": "Stock moving between two of our warehouses: it has left one and not yet arrived at the other.",
  "2100": "Payments taken at checkout (Shopify, Amazon, showroom) before the goods ship; applied to the invoice when they do.",
  "5200": "Cent differences when a landed cost does not divide evenly across the units received.",
  "5300": "Parts consumed from stock on a repair. Not used yet: no screen posts it.",
  "5400": "Replacement units given under warranty. Not used yet: no screen posts it.",
};

const TYPE_LABEL: Record<string, string> = {
  ASSET: "Current Assets",
  LIABILITY: "Current Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

/** Sheet sections 2–4, in the sheet's order and wording. */
const SHEET_RULES: { area: string; items: { ref: string; title: string; note: string; type: string }[] }[] = [
  {
    area: "Purchasing",
    items: [
      { ref: "2.1", title: "Bill (Vendor Invoice / Purchase on Credit)", type: "PURCHASE_BILL",
        note: "Records a bill received from a supplier for inventory. Goods are not yet put into stock; they sit in the inbound clearing account." },
      { ref: "2.2", title: "Bill Payment (Pay Vendor)", type: "PURCHASE_PAYMENT",
        note: "Payment of the vendor bill from bank/cash. Clears the Accounts Payable balance." },
      { ref: "2.3", title: "Goods Receipt (GR) – Inbound", type: "GOODS_RECEIPT",
        note: "Moves value from the inbound clearing account into on-hand Inventory." },
    ],
  },
  {
    area: "Sales",
    items: [
      { ref: "3.1 A", title: "Invoice – Revenue recognition", type: "SALES_INVOICE",
        note: "Recognise revenue and the receivable." },
      { ref: "3.1 B", title: "Invoice – Cost of goods sold", type: "INVOICE_COGS",
        note: "Recognise cost of goods sold and relieve outbound clearing." },
      { ref: "3.2", title: "Customer Payment (Receipt against AR)", type: "SALES_PAYMENT",
        note: "Cash/bank receipt from the customer that settles the Accounts Receivable." },
      { ref: "3.3", title: "Goods Issue (GI) – Outbound", type: "GOODS_ISSUE",
        note: "Relieves on-hand Inventory and posts to the outbound clearing account (later cleared by the COGS entry on the invoice)." },
    ],
  },
  {
    area: "Inventory",
    items: [
      { ref: "4.1", title: "Opening Balance – Inventory", type: "OPENING_BALANCE",
        note: "Initial stock value when opening the books. Offset is Opening Balance Equity." },
      { ref: "4.2", title: "Inventory Adjustment – Gain", type: "ADJUSTMENT_INCREASE",
        note: "Overage / found stock on a physical count." },
      { ref: "4.2", title: "Inventory Adjustment – Loss", type: "ADJUSTMENT_DECREASE",
        note: "Shortage / shrinkage on a physical count." },
    ],
  },
];

/** Rules the app posts that the sheet does not cover. */
const APP_RULES: { title: string; type: string; note?: string }[] = [
  { title: "Checkout payment (customer deposit)", type: "CUSTOMER_DEPOSIT" },
  { title: "Deposit applied to the invoice", type: "DEPOSIT_APPLIED" },
  { title: "Customer return – credit", type: "SALES_RETURN" },
  { title: "Customer return – restock", type: "RETURN_RESTOCK" },
  { title: "Customer refund", type: "CUSTOMER_REFUND" },
  { title: "Transfer out (into transit)", type: "INVENTORY_TRANSFER" },
  { title: "Transfer in (out of transit)", type: "INVENTORY_TRANSFER_IN" },
  { title: "Repair parts used", type: "REPAIR_PARTS_CONSUMPTION", note: "Not used yet: no screen posts it." },
  { title: "Warranty replacement", type: "WARRANTY_REPLACEMENT", note: "Not used yet: no screen posts it." },
];

function useReference() {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ data: Account[] }>("/accounts") });
  const rules = useQuery({ queryKey: ["journal-templates"], queryFn: () => api.get<{ data: Rule[] }>("/journal-templates") });
  const trial = useQuery({ queryKey: ["trial-balance"], queryFn: () => api.get<TrialBalance>("/trial-balance") });
  return { accounts, rules, trial };
}

export function ChartOfAccounts() {
  const { accounts, trial } = useReference();
  const balance = (code: string) => trial.data?.accounts.find((a) => a.code === code)?.balanceCents;
  const groups = Object.keys(TYPE_LABEL)
    .map((type) => ({ type, rows: (accounts.data?.data ?? []).filter((a) => a.accountType === type) }))
    .filter((g) => g.rows.length > 0);

  return (
    <QueryState isLoading={accounts.isLoading} error={accounts.error} onRetry={accounts.refetch}>
      <Text size="sm" c="dimmed" mb="sm">
        From the client's sheet "Chart of Accounts &amp; Transaction Journal Entries", section 1. Accounts marked{" "}
        <Badge size="xs" variant="light" color="gray">added</Badge> are not on the sheet; the app needs them for the reason given.
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
                <Table.Th>Description / notes</Table.Th>
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

function GroupRows({
  label,
  rows,
  balance,
}: {
  label: string;
  rows: Account[];
  balance: (code: string) => number | undefined;
}) {
  return (
    <>
      <Table.Tr>
        <Table.Td colSpan={6} className="coa-group">
          {label}
        </Table.Td>
      </Table.Tr>
      {rows.map((a) => {
        const sheet = SHEET_NOTES[a.code];
        const b = balance(a.code);
        return (
          <Table.Tr key={a.code}>
            <Table.Td fw={600}>{a.code}</Table.Td>
            <Table.Td>
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={500}>{a.name}</Text>
                {!sheet && <Badge size="xs" variant="light" color="gray" style={{ flex: "none" }}>added</Badge>}
              </Group>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{a.code === "5000" ? "Expenses (COGS)" : label}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{a.normalSide === "DEBIT" ? "Debit" : "Credit"}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c={sheet ? undefined : "dimmed"}>{sheet ?? APP_NOTES[a.code] ?? ""}</Text>
            </Table.Td>
            <Table.Td ta="right">{money(b ?? 0)}</Table.Td>
          </Table.Tr>
        );
      })}
    </>
  );
}

export function PostingRules({ onShowEntries }: { onShowEntries: (transactionType: string) => void }) {
  const { rules } = useReference();
  const byType = (t: string) => rules.data?.data.find((r) => r.transactionType === t);

  return (
    <QueryState isLoading={rules.isLoading} error={rules.error} onRetry={rules.refetch}>
      <Text size="sm" c="dimmed" mb="md">
        From the client's sheet, sections 2–4, with the debit and credit the app actually posts. Every rule below is read
        from the live ledger settings.
      </Text>
      <Stack gap="xl">
        {SHEET_RULES.map((section) => (
          <div key={section.area}>
            <Title order={2} size="h4" mb="sm">
              {section.area}
            </Title>
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
              {section.items.map((item) => (
                <RuleCard key={item.type} refLabel={item.ref} title={item.title} note={item.note} rule={byType(item.type)} onShowEntries={onShowEntries} />
              ))}
            </SimpleGrid>
          </div>
        ))}
        <div>
          <Title order={2} size="h4" mb={4}>
            Added by ProfitIndex
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            Not on the sheet: checkout payments, returns and transfers between warehouses need their own entries.
          </Text>
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">
            {APP_RULES.map((item) => (
              <RuleCard key={item.type} title={item.title} note={item.note} rule={byType(item.type)} onShowEntries={onShowEntries} />
            ))}
          </SimpleGrid>
        </div>
      </Stack>
    </QueryState>
  );
}

function RuleCard({
  refLabel,
  title,
  note,
  rule,
  onShowEntries,
}: {
  refLabel?: string;
  title: string;
  note?: string;
  rule?: Rule;
  onShowEntries: (transactionType: string) => void;
}) {
  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb={4}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        {refLabel && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            Sheet {refLabel}
          </Text>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {note ?? rule?.description}
      </Text>
      {rule ? (
        <Table verticalSpacing={4} className="rule-table">
          <Table.Tbody>
            <Table.Tr>
              <Table.Td w={36} fw={600}>Dr</Table.Td>
              <Table.Td>
                {rule.debitAccountCode} {rule.debitAccountName}
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td w={36} fw={600}>Cr</Table.Td>
              <Table.Td>
                {rule.creditAccountCode} {rule.creditAccountName}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="sm" c="var(--warn-fg)">
          This rule is missing from the ledger settings.
        </Text>
      )}
      {rule && !note?.startsWith("Not used yet") && (
        <Anchor
          component="button"
          type="button"
          size="sm"
          mt="xs"
          style={{ alignSelf: "flex-start" }}
          onClick={() => onShowEntries(rule.transactionType)}
        >
          Show these entries
        </Anchor>
      )}
    </Card>
  );
}
