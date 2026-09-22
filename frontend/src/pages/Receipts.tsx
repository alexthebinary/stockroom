import {
  Anchor,
  Badge,
  Card,
  Group,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type GoodsReceiptRow, type Paginated } from "../api";
import { PageHeader, QueryState, Stat, formatDate, money } from "../components/ui";
import { useWarehouseOptions } from "../hooks";

/**
 * Goods receipts across every purchase order — the inbound mirror of
 * Deliveries.
 *
 * The figure here is LANDED COST, not order value: posting a receipt is what
 * creates the FIFO layers, and this is what they were created at.
 */
export default function Receipts() {
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const warehouses = useWarehouseOptions();

  const list = useQuery({
    queryKey: ["goods-receipts", { warehouseId, search, page }],
    queryFn: () =>
      api.get<Paginated<GoodsReceiptRow>>(
        `/purchase-orders/goods-receipts${qs({ warehouseId, search, page, pageSize: 25 })}`
      ),
  });

  const rows = list.data?.data ?? [];
  const landed = rows.reduce((sum, g) => sum + g.totalCostCents, 0);
  // Count ORDERS, not receipt rows: three partial deliveries against one order
  // are one order still short, not three.
  const shortOrders = new Set(
    rows.filter((g) => !g.orderComplete).map((g) => g.purchaseOrderId)
  ).size;

  return (
    <>
      <PageHeader
        title="Goods receipts"
        subtitle="Everything that has arrived on a dock. Posting a receipt is what creates the FIFO cost layers, so these figures are landed cost."
      />

      <Group grow mb="lg" align="stretch">
        <Stat label="Receipts on this page" value={rows.length} />
        <Stat
          label="Landed cost on this page"
          value={money(landed)}
          hint="What the cost layers were created at"
        />
        <Stat
          label="Orders still short"
          value={shortOrders}
          hint={shortOrders > 0 ? "Deliveries outstanding" : "Every order fully received"}
        />
      </Group>

      <Card withBorder radius="md" p="md" mb="lg">
        <Group align="flex-end" wrap="wrap" gap="sm">
          <Select
            label="Warehouse"
            placeholder="Any"
            clearable
            w={220}
            value={warehouseId}
            onChange={(value) => {
              setWarehouseId(value);
              setPage(1);
            }}
            data={warehouses.options}
          />
          <TextInput
            label="Search"
            placeholder="Receipt, order or vendor"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            w={280}
          />
        </Group>
      </Card>

      <Card withBorder radius="md" p={0}>
        <QueryState
          isLoading={list.isLoading}
          error={list.error}
          isEmpty={rows.length === 0}
          emptyMessage="Nothing received yet."
          onRetry={list.refetch}
        >
          <Table.ScrollContainer minWidth={820}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Receipt</Table.Th>
                  <Table.Th>Received</Table.Th>
                  <Table.Th>Order</Table.Th>
                  <Table.Th>Vendor</Table.Th>
                  <Table.Th>Into</Table.Th>
                  <Table.Th ta="right">Landed cost</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Document</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((grn) => (
                  <Table.Tr key={grn.id}>
                    <Table.Td fw={600}>{grn.grnNumber}</Table.Td>
                    <Table.Td>{formatDate(grn.receivedAt)}</Table.Td>
                    <Table.Td>
                      {grn.purchaseOrder ? (
                        <Anchor component={Link} to={`/purchase-orders/${grn.purchaseOrder.id}`}>
                          {grn.purchaseOrder.poNumber}
                        </Anchor>
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>{grn.purchaseOrder?.supplierName ?? "—"}</Table.Td>
                    <Table.Td>
                      {/* Null when the order landed in more than one
                          warehouse — the lines are the authority, not this. */}
                      {grn.warehouse ? grn.warehouse.code : "Multiple"}
                    </Table.Td>
                    <Table.Td ta="right">{money(grn.totalCostCents)}</Table.Td>
                    <Table.Td>
                      {/* The document status only ever read POSTED, which
                          carried no information. What a dock actually wants to
                          know is whether the ORDER is still short. */}
                      {grn.orderComplete ? (
                        <Badge variant="light" color="teal">
                          Complete
                        </Badge>
                      ) : (
                        <Group gap={6} wrap="nowrap">
                          <Badge variant="light" color="orange">
                            Partial
                          </Badge>
                          <Text span size="xs" c="dimmed">
                            {grn.orderReceivedQty} of {grn.orderQuantity}
                          </Text>
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Anchor
                        href={`/api/purchase-orders/goods-receipts/${grn.id}/note.pdf`}
                        target="_blank"
                        rel="noreferrer"
                        size="sm"
                      >
                        Receipt note
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
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
