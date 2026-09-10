import {
  Anchor,
  Autocomplete,
  Button,
  Card,
  Grid,
  NumberInput,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type Adjustment, type Paginated } from "../api";
import { PageHeader, QueryState, StatusBadge, formatDate, money, toastErr, toastOk } from "../components/ui";
import { useProductOptions, useWarehouseOptions } from "../hooks";

const REASONS = ["Cycle count", "Damage", "Sample", "Theft or loss", "Found stock", "Supplier credit"];

export default function Adjustments() {
  const [productId, setProductId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [adjustmentType, setAdjustmentType] = useState<string>("INCREASE");
  const [quantity, setQuantity] = useState<number | "">(1);
  const [reason, setReason] = useState<string>("Cycle count");
  const [unitCostCents, setUnitCostCents] = useState<number>(0);
  const [page, setPage] = useState(1);

  const products = useProductOptions();
  const warehouses = useWarehouseOptions();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["stock-adjustments", page],
    queryFn: () => api.get<Paginated<Adjustment>>(`/stock-adjustments${qs({ page, pageSize: 20 })}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Adjustment>("/stock-adjustments", {
        productId: Number(productId),
        warehouseId: Number(warehouseId),
        adjustmentType,
        quantity: Number(quantity),
        reason: reason.trim(),
        // Only read on an increase; a decrease is valued at FIFO cost.
        ...(adjustmentType === "INCREASE" ? { unitCostCents } : {}),
      }),
    onSuccess: () => {
      toastOk("Stock adjusted");
      setQuantity(1);
      // Balances, movements and the dashboard all shift after an adjustment.
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const canSubmit =
    productId !== null && warehouseId !== null && Number(quantity) > 0 && reason.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Stock adjustments"
        subtitle="Move on-hand stock up or down outside the order flows. Every adjustment writes a movement."
      />

      <Card withBorder radius="md" p="md" mb="lg">
        <Title order={5} mb="sm">
          New adjustment
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
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Select
              label="Warehouse"
              placeholder="Pick a warehouse"
              data={warehouses.options}
              value={warehouseId}
              onChange={setWarehouseId}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 2 }}>
            <Select
              label="Direction"
              data={[
                { value: "INCREASE", label: "Increase" },
                { value: "DECREASE", label: "Decrease" },
              ]}
              value={adjustmentType}
              onChange={(v) => setAdjustmentType(v ?? "INCREASE")}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 6, md: 3 }}>
            <NumberInput
              label="Quantity"
              min={1}
              value={quantity}
              onChange={(v) => setQuantity(v === "" ? "" : Number(v))}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 9 }}>
            {/* Free text is still allowed, but the six known answers are one
                click away — otherwise the history fills with spellings of
                "damage". */}
            <Autocomplete
              label="Reason"
              placeholder="Why is the count changing?"
              data={REASONS}
              value={reason}
              onChange={setReason}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 3 }}>
            <Button type="submit" fullWidth loading={create.isPending} disabled={!canSubmit}>
              Apply adjustment
            </Button>
          </Grid.Col>
        </Grid>
        </form>
      </Card>

      <Card withBorder radius="md" p="md">
        <Title order={5} mb="sm">
          Recent adjustments
        </Title>
        <QueryState
          isLoading={list.isLoading}
          error={list.error}
          isEmpty={(list.data?.data.length ?? 0) === 0}
          emptyMessage="No adjustments recorded yet."
        >
          <Table.ScrollContainer minWidth={720}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>SKU</Table.Th>
                  <Table.Th>Warehouse</Table.Th>
                  <Table.Th>Direction</Table.Th>
                  <Table.Th ta="right">Qty</Table.Th>
                  <Table.Th ta="right">Value</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Actor</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.data?.data.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(a.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/products/${a.productId}`}>{a.product?.sku}</Anchor>
                    </Table.Td>
                    <Table.Td>{a.warehouse?.code}</Table.Td>
                    <Table.Td>
                      <StatusBadge value={a.adjustmentType} />
                    </Table.Td>
                    <Table.Td ta="right">{a.quantity}</Table.Td>
                    <Table.Td ta="right">
                      {a.totalCostCents ? money(a.totalCostCents) : "—"}
                    </Table.Td>
                    <Table.Td>{a.reason}</Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {a.actor}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {list.data && list.data.totalPages > 1 && (
            <Pagination value={page} onChange={setPage} total={list.data.totalPages} size="sm" mt="md" />
          )}
        </QueryState>
      </Card>
    </>
  );
}
