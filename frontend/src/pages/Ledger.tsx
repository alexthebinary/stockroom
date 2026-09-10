import {
  Alert,
  Button,
  Card,
  Grid,
  Group,
  Pagination,
  Select,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, qs, type JournalEntry, type Paginated, type TrialBalance } from "../api";
import {
  PageHeader,
  QueryState,
  StatusBadge,
  formatDate,
  formatStatus,
  money,
  toastErr,
  toastOk,
} from "../components/ui";

const TRANSACTION_TYPES = [
  "SALES_INVOICE",
  "SALES_PAYMENT",
  "SALES_SHIPMENT_COGS",
  "PURCHASE_BILL",
  "PURCHASE_PAYMENT",
  "GOODS_RECEIPT",
  "INVENTORY_TRANSFER",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
];

export default function Ledger() {
  const [transactionType, setTransactionType] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  /**
   * Reversing posts a mirror-image contra entry. The original stays on the
   * record — double-entry never deletes history.
   */
  const reverse = useMutation({
    mutationFn: (id: number) => api.post(`/journal-entries/${id}/reverse`),
    onSuccess: () => {
      toastOk("Entry reversed with a contra entry");
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const trial = useQuery({
    queryKey: ["trial-balance"],
    queryFn: () => api.get<TrialBalance>("/trial-balance"),
  });

  const entries = useQuery({
    queryKey: ["journal-entries", { transactionType, page }],
    queryFn: () =>
      api.get<Paginated<JournalEntry>>(`/journal-entries${qs({ transactionType, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Accounting"
        subtitle="Every financial transaction, with each entry re-proved on its own and the accounting equation checked."
      />

      <QueryState isLoading={trial.isLoading} error={trial.error} onRetry={trial.refetch}>
        {trial.data && (
          <Alert
            mb="md"
            color={trial.data.balanced ? "teal" : "red"}
            icon={trial.data.balanced ? <IconCheck size={18} /> : <IconAlertTriangle size={18} />}
            title={
              trial.data.balanced
                ? `Books are sound across ${trial.data.entryCount} posted entries`
                : "The books do not tie out"
            }
          >
            <Text size="sm">
              {/* Debits == credits cannot fail while every entry goes through
                  the ledger engine, so the two checks that CAN fail are the
                  ones reported. */}
              {trial.data.unbalancedEntries.length === 0
                ? "Every entry balances on its own"
                : `${trial.data.unbalancedEntries.length} entr${trial.data.unbalancedEntries.length === 1 ? "y does" : "ies do"} not balance: ${trial.data.unbalancedEntries.map((e) => e.entryNumber).join(", ")}`}
              {" · "}
              {trial.data.equationVarianceCents === 0
                ? "and the accounting equation holds"
                : `and the accounting equation is off by ${money(trial.data.equationVarianceCents)}`}
              .
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Assets {money(trial.data.assetsCents)} = liabilities{" "}
              {money(trial.data.liabilitiesCents)} + equity {money(trial.data.equityCents)} + income{" "}
              {money(trial.data.incomeCents)} − expenses {money(trial.data.expensesCents)}
            </Text>
          </Alert>
        )}
      </QueryState>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Card withBorder radius="md" p="md" h="100%">
            <Title order={5} mb="sm">
              Trial balance
            </Title>
            <QueryState
              isLoading={trial.isLoading}
              error={trial.error}
              isEmpty={(trial.data?.accounts.length ?? 0) === 0}
              emptyMessage="Nothing has been posted yet."
            >
              <Table className="data-grid" verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Account</Table.Th>
                    <Table.Th ta="right">Debits</Table.Th>
                    <Table.Th ta="right">Credits</Table.Th>
                    <Table.Th ta="right">Balance</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {trial.data?.accounts.map((a) => (
                    <Table.Tr key={a.code}>
                      <Table.Td>
                        <Text size="sm">{a.name}</Text>
                        <Text size="xs" c="dimmed">
                          {a.code} · {a.accountType.toLowerCase()}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{money(a.debitCents)}</Table.Td>
                      <Table.Td ta="right">{money(a.creditCents)}</Table.Td>
                      <Table.Td ta="right" fw={700}>
                        {money(a.balanceCents)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </QueryState>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card withBorder radius="md" p="md" h="100%">
            <Group justify="space-between" mb="sm">
              <Title order={5}>Journal entries</Title>
              <Select
                placeholder="All transaction types"
                data={TRANSACTION_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))}
                value={transactionType}
                onChange={(v) => {
                  setTransactionType(v);
                  setPage(1);
                }}
                clearable
                size="xs"
                w={230}
              />
            </Group>

            <QueryState
              isLoading={entries.isLoading}
              error={entries.error}
              isEmpty={(entries.data?.data.length ?? 0) === 0}
              emptyMessage="No entries match that filter."
              onRetry={entries.refetch}
            >
              <Table.ScrollContainer minWidth={560}>
                <Table className="data-grid" verticalSpacing={6}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Entry</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Postings</Table.Th>
                      <Table.Th ta="right">Amount</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {entries.data?.data.map((e) => (
                      <Table.Tr key={e.id}>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {e.entryNumber}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {formatDate(e.entryDate)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{formatStatus(e.transactionType)}</Text>
                        </Table.Td>
                        <Table.Td>
                          {/* Both sides of the entry, so a reader can see the
                              double entry rather than take it on trust. */}
                          {e.lines.map((l) => (
                            <Text key={l.id} size="xs" c="dimmed">
                              {l.debitCents > 0 ? "Dr" : "Cr"} {l.account?.name}
                            </Text>
                          ))}
                        </Table.Td>
                        <Table.Td ta="right" fw={600}>
                          {money(e.totalDebitCents ?? 0)}
                        </Table.Td>
                        <Table.Td>
                          <StatusBadge value={e.status} />
                        </Table.Td>
                        <Table.Td>
                          {e.status === "POSTED" &&
                            !e.transactionType.endsWith("_REVERSAL") && (
                              <Button
                                size="compact-xs"
                                variant="subtle"
                                loading={reverse.isPending && reverse.variables === e.id}
                                onClick={() => reverse.mutate(e.id)}
                              >
                                Reverse
                              </Button>
                            )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>

              {entries.data && entries.data.totalPages > 1 && (
                <Group justify="flex-end" mt="sm">
                  <Pagination
                    value={page}
                    onChange={setPage}
                    total={entries.data.totalPages}
                    size="sm"
                  />
                </Group>
              )}
            </QueryState>
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
