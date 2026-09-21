import {
  Anchor,
  Badge,
  Card,
  Group,
  Pagination,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type InvoiceRow, type Paginated } from "../api";
import { PageHeader, QueryState, Stat, formatDate, money } from "../components/ui";

type Settlement = "" | "UNPAID" | "PAID";

/**
 * Invoices across every order.
 *
 * Until now an invoice existed only inside the sales order that produced it,
 * so "who owes us money" required opening orders one at a time. The balance
 * shown here is computed per request from live payments rather than stored:
 * a payment can be reversed, and a cached balance is a second source of truth
 * that goes stale without anyone noticing.
 */
export default function Invoices() {
  const [settlement, setSettlement] = useState<Settlement>("");
  const [status, setStatus] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ["invoices", { settlement, status, search, page }],
    queryFn: () =>
      api.get<Paginated<InvoiceRow> & { partialFilter?: boolean }>(
        `/sales-orders/invoices${qs({ settlement, status, search, page, pageSize: 25 })}`
      ),
  });

  const rows = list.data?.data ?? [];
  const outstanding = rows
    .filter((i) => i.status !== "VOID")
    .reduce((sum, i) => sum + i.outstandingCents, 0);
  const invoiced = rows
    .filter((i) => i.status !== "VOID")
    .reduce((sum, i) => sum + i.totalCents, 0);

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Every invoice raised, across all orders. Outstanding is computed from live payments, so reversing one moves this figure immediately."
      />

      <Group grow mb="lg" align="stretch">
        <Stat label="Invoiced on this page" value={money(invoiced)} />
        <Stat
          label="Outstanding on this page"
          value={money(outstanding)}
          hint={outstanding > 0 ? "Money owed to us" : "Nothing owed on these rows"}
        />
      </Group>

      <Card withBorder radius="md" p="md" mb="lg">
        <Group align="flex-end" wrap="wrap" gap="sm">
          <SegmentedControl
            value={settlement}
            onChange={(value) => {
              setSettlement(value as Settlement);
              setPage(1);
            }}
            data={[
              { label: "All", value: "" },
              { label: "Unpaid", value: "UNPAID" },
              { label: "Paid", value: "PAID" },
            ]}
          />
          <Select
            label="Document status"
            placeholder="Any"
            clearable
            w={180}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            data={["SAVED", "POSTED", "VOID"]}
          />
          <TextInput
            label="Search"
            placeholder="Invoice, order or customer"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            w={260}
          />
        </Group>
        {list.data?.partialFilter && (
          <Text size="xs" c="dimmed" mt="sm">
            Paid and unpaid are worked out from live payments, so this filter narrows the
            current page rather than the whole list. Clear it to page through everything.
          </Text>
        )}
      </Card>

      <Card withBorder radius="md" p={0}>
        <QueryState
          isLoading={list.isLoading}
          error={list.error}
          isEmpty={rows.length === 0}
          emptyMessage="No invoices match these filters."
          onRetry={list.refetch}
        >
          <Table.ScrollContainer minWidth={860}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Invoice</Table.Th>
                  <Table.Th>Issued</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th>Order</Table.Th>
                  <Table.Th ta="right">Total</Table.Th>
                  <Table.Th ta="right">Paid</Table.Th>
                  <Table.Th ta="right">Outstanding</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((invoice) => {
                  const settled = invoice.status !== "VOID" && invoice.outstandingCents === 0;
                  return (
                    <Table.Tr key={invoice.id}>
                      <Table.Td>
                        <Anchor
                          component="a"
                          href={`/api/sales-orders/invoices/${invoice.id}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          fw={600}
                        >
                          {invoice.invoiceNumber}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{formatDate(invoice.issueDate)}</Table.Td>
                      <Table.Td>{invoice.customer?.name ?? "—"}</Table.Td>
                      <Table.Td>
                        {invoice.salesOrder ? (
                          <Anchor component={Link} to={`/sales-orders/${invoice.salesOrder.id}`}>
                            {invoice.salesOrder.orderNumber}
                          </Anchor>
                        ) : (
                          "—"
                        )}
                      </Table.Td>
                      <Table.Td ta="right">{money(invoice.totalCents)}</Table.Td>
                      <Table.Td ta="right">{money(invoice.amountPaidCents)}</Table.Td>
                      <Table.Td ta="right">
                        {/* A void invoice owes nothing, but showing 0 alongside a
                            live 0 hides which is which. */}
                        {invoice.status === "VOID" ? (
                          <Text span c="dimmed">
                            —
                          </Text>
                        ) : (
                          <Text span fw={invoice.outstandingCents > 0 ? 700 : 400}>
                            {money(invoice.outstandingCents)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={
                            invoice.status === "VOID" ? "gray" : settled ? "teal" : "orange"
                          }
                        >
                          {invoice.status === "VOID" ? "Void" : settled ? "Paid" : "Unpaid"}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </QueryState>
      </Card>

      {(list.data?.totalPages ?? 1) > 1 && (
        <Group justify="flex-end" mt="md">
          <Pagination value={page} onChange={setPage} total={list.data?.totalPages ?? 1} />
        </Group>
      )}
    </>
  );
}
