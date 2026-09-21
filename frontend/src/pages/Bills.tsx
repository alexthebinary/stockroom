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
import { api, qs, type BillRow, type Paginated } from "../api";
import { PageHeader, QueryState, Stat, formatDate, money } from "../components/ui";

type Settlement = "" | "UNPAID" | "PAID";

/**
 * Vendor bills across every purchase order — the inbound mirror of Invoices.
 *
 * A bill existed only inside the order that produced it, so "what do we owe"
 * meant opening orders one at a time. The balance is computed per request from
 * live payments rather than stored: a payment can be reversed, and a cached
 * balance is a second source of truth that goes stale silently.
 */
export default function Bills() {
  const [settlement, setSettlement] = useState<Settlement>("");
  const [status, setStatus] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ["bills", { settlement, status, search, page }],
    queryFn: () =>
      api.get<Paginated<BillRow> & { partialFilter?: boolean }>(
        `/purchase-orders/bills${qs({ settlement, status, search, page, pageSize: 25 })}`
      ),
  });

  const rows = list.data?.data ?? [];
  const live = rows.filter((b) => b.status !== "VOID");
  const billed = live.reduce((sum, b) => sum + b.totalCents, 0);
  const outstanding = live.reduce((sum, b) => sum + b.outstandingCents, 0);

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Every bill a vendor has raised against us. Outstanding is computed from live payments, so reversing one moves this figure immediately."
      />

      <Group grow mb="lg" align="stretch">
        <Stat label="Billed on this page" value={money(billed)} />
        <Stat
          label="We still owe on this page"
          value={money(outstanding)}
          hint={outstanding > 0 ? "Money we owe vendors" : "Nothing owed on these rows"}
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
            placeholder="Bill, order or vendor"
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
          emptyMessage="No bills match these filters."
          onRetry={list.refetch}
        >
          <Table.ScrollContainer minWidth={860}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Bill</Table.Th>
                  <Table.Th>Issued</Table.Th>
                  <Table.Th>Vendor</Table.Th>
                  <Table.Th>Order</Table.Th>
                  <Table.Th ta="right">Total</Table.Th>
                  <Table.Th ta="right">Paid</Table.Th>
                  <Table.Th ta="right">Outstanding</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((bill) => {
                  const settled = bill.status !== "VOID" && bill.outstandingCents === 0;
                  return (
                    <Table.Tr key={bill.id}>
                      {/* No PDF link: a vendor bill is a document THEY issue
                          and we file. Re-rendering ours would be a forgery. */}
                      <Table.Td fw={600}>{bill.billNumber}</Table.Td>
                      <Table.Td>{formatDate(bill.issueDate)}</Table.Td>
                      <Table.Td>{bill.vendor?.name ?? "—"}</Table.Td>
                      <Table.Td>
                        {bill.purchaseOrder ? (
                          <Anchor component={Link} to={`/purchase-orders/${bill.purchaseOrder.id}`}>
                            {bill.purchaseOrder.poNumber}
                          </Anchor>
                        ) : (
                          "—"
                        )}
                      </Table.Td>
                      <Table.Td ta="right">{money(bill.totalCents)}</Table.Td>
                      <Table.Td ta="right">{money(bill.amountPaidCents)}</Table.Td>
                      <Table.Td ta="right">
                        {bill.status === "VOID" ? (
                          <Text span c="dimmed">
                            —
                          </Text>
                        ) : (
                          <Text span fw={bill.outstandingCents > 0 ? 700 : 400}>
                            {money(bill.outstandingCents)}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={bill.status === "VOID" ? "gray" : settled ? "teal" : "orange"}
                        >
                          {bill.status === "VOID" ? "Void" : settled ? "Paid" : "Unpaid"}
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
