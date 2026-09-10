import {
  Anchor,
  Button,
  Card,
  Grid,
  Group,
  NumberInput,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs, type Paginated, type Transfer } from "../api";
import {
  PageHeader,
  QueryState,
  StatusCell,
  formatDate,
  formatStatus,
  money,
  toastErr,
  toastOk,
} from "../components/ui";
import { useProductOptions, useWarehouseOptions } from "../hooks";

export default function Transfers() {
  const [searchParams] = useSearchParams();
  const [productId, setProductId] = useState<string | null>(null);
  const [fromWarehouseId, setFromWarehouseId] = useState<string | null>(null);
  const [toWarehouseId, setToWarehouseId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | "">(1);
  const [notes, setNotes] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const products = useProductOptions();
  const warehouses = useWarehouseOptions();
  const queryClient = useQueryClient();

  // "New transfer from this warehouse" on the warehouse page lands here with ?from=
  const fromParam = searchParams.get("from");
  useEffect(() => {
    if (fromParam) setFromWarehouseId(fromParam);
  }, [fromParam]);

  const list = useQuery({
    queryKey: ["stock-transfers", { statusFilter, page }],
    queryFn: () =>
      api.get<Paginated<Transfer>>(`/stock-transfers${qs({ status: statusFilter, page, pageSize: 20 })}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Transfer>("/stock-transfers", {
        productId: Number(productId),
        fromWarehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(toWarehouseId),
        quantity: Number(quantity),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toastOk("Transfer created as a draft");
      setQuantity(1);
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["stock-transfers"] });
    },
    onError: toastErr,
  });

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: "start" | "complete" | "cancel" }) =>
      api.post<Transfer>(`/stock-transfers/${id}/${verb}`),
    onSuccess: (transfer) => {
      toastOk(`Transfer #${transfer.id} is now ${formatStatus(transfer.status).toLowerCase()}`);
      // Stock moved, so balances and movements everywhere are stale.
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const canSubmit =
    productId !== null &&
    fromWarehouseId !== null &&
    toWarehouseId !== null &&
    fromWarehouseId !== toWarehouseId &&
    Number(quantity) > 0;

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Stock transfers"
        subtitle="Start pulls stock out of the source at its FIFO cost; complete lands it at the destination with that cost and age intact."
      />

      <Card withBorder radius="md" p="md" mb="lg">
        <Title order={5} mb="sm">
          New transfer
        </Title>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
        <Grid align="flex-end">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Select
              label="Product"
              placeholder="Pick a product"
              data={products.options}
              value={productId}
              onChange={setProductId}
              searchable
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 3 }}>
            <Select
              label="From"
              placeholder="Source"
              data={warehouses.options}
              value={fromWarehouseId}
              onChange={setFromWarehouseId}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 3 }}>
            <Select
              label="To"
              placeholder="Destination"
              data={warehouses.options.filter((o) => o.value !== fromWarehouseId)}
              value={toWarehouseId}
              onChange={setToWarehouseId}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 2 }}>
            <NumberInput
              label="Quantity"
              min={1}
              value={quantity}
              onChange={(v) => setQuantity(v === "" ? "" : Number(v))}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>
            <TextInput
              label="Notes"
              placeholder="Why is this stock moving?"
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Button type="submit" fullWidth loading={create.isPending} disabled={!canSubmit}>
              Create transfer
            </Button>
          </Grid.Col>
        </Grid>
        </form>
      </Card>

      <Card withBorder radius="md" p="md">
        <Group justify="space-between" mb="sm">
          <Title order={5}>Transfers</Title>
          <Select
            placeholder="Any status"
            data={["DRAFT", "IN_TRANSIT", "COMPLETED", "CANCELED"]}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            clearable
            size="xs"
            w={190}
          />
        </Group>

        <QueryState
          isLoading={list.isLoading}
          error={list.error}
          isEmpty={rows.length === 0}
          emptyMessage="No transfers yet."
        >
          <Table.ScrollContainer minWidth={860}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>#</Table.Th>
                  <Table.Th>SKU</Table.Th>
                  <Table.Th>From</Table.Th>
                  <Table.Th>To</Table.Th>
                  <Table.Th ta="right">Qty</Table.Th>
                  <Table.Th ta="right">Cost</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((t) => {
                  const busy = action.isPending && action.variables?.id === t.id;
                  return (
                    <Table.Tr key={t.id}>
                      <Table.Td>{t.id}</Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={`/products/${t.productId}`}>{t.product?.sku}</Anchor>
                      </Table.Td>
                      <Table.Td>{t.fromWarehouse?.code}</Table.Td>
                      <Table.Td>{t.toWarehouse?.code}</Table.Td>
                      <Table.Td ta="right">{t.quantity}</Table.Td>
                      <Table.Td ta="right">
                        {t.costCents > 0 ? money(t.costCents) : "—"}
                      </Table.Td>
                      <Table.Td p={0}>
                        <StatusCell value={t.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {formatDate(t.createdAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Button
                            size="xs"
                            variant="light"
                            loading={busy && action.variables?.verb === "start"}
                            disabled={t.status !== "DRAFT"}
                            onClick={() => action.mutate({ id: t.id, verb: "start" })}
                          >
                            Start
                          </Button>
                          <Button
                            size="xs"
                            variant="light"
                            color="teal"
                            loading={busy && action.variables?.verb === "complete"}
                            disabled={t.status !== "IN_TRANSIT"}
                            onClick={() => action.mutate({ id: t.id, verb: "complete" })}
                          >
                            Complete
                          </Button>
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            loading={busy && action.variables?.verb === "cancel"}
                            disabled={t.status === "COMPLETED" || t.status === "CANCELED"}
                            onClick={() => action.mutate({ id: t.id, verb: "cancel" })}
                          >
                            Cancel
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {list.data && list.data.totalPages > 1 && (
            <Group justify="flex-end" mt="md">
              <Pagination value={page} onChange={setPage} total={list.data.totalPages} size="sm" />
            </Group>
          )}
        </QueryState>
      </Card>
    </>
  );
}
