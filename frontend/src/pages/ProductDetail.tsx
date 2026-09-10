import {
  Anchor,
  Badge,
  Card,
  Grid,
  Group,
  SimpleGrid,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, qs, type Balance, type InventoryLot, type Movement, type Paginated, type Product } from "../api";
import { MovementRoute, PageHeader, QueryState, StatusBadge, formatDate, money } from "../components/ui";

type ProductDetailResponse = Product & { balances: Balance[] };

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm">{value === null || value === undefined || value === "" ? "—" : value}</Text>
    </div>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const productId = Number(id);

  const product = useQuery({
    queryKey: ["product", productId],
    queryFn: () => api.get<ProductDetailResponse>(`/products/${productId}`),
    enabled: Number.isFinite(productId),
  });

  const lots = useQuery({
    queryKey: ["inventory-lots", { productId }],
    queryFn: () =>
      api.get<Paginated<InventoryLot>>(`/inventory-lots${qs({ productId, openOnly: true, pageSize: 50 })}`),
    enabled: Number.isFinite(productId),
  });

  const movements = useQuery({
    queryKey: ["movements", { productId }],
    queryFn: () =>
      api.get<Paginated<Movement>>(`/inventory-movements${qs({ productId, pageSize: 50 })}`),
    enabled: Number.isFinite(productId),
  });

  return (
    <>
      <PageHeader
        title={product.data ? product.data.sku : "Product"}
        subtitle={product.data?.name}
        action={
          product.data && (
            <Badge color={product.data.isActive ? "teal" : "gray"} variant="light" size="lg">
              {product.data.isActive ? "Active" : "Inactive"}
            </Badge>
          )
        }
      />

      <QueryState isLoading={product.isLoading} error={product.error}>
        {product.data && (
          <Grid>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Card withBorder radius="md" p="md" h="100%">
                <Title order={5} mb="sm">
                  Details
                </Title>
                <SimpleGrid cols={2} spacing="sm">
                  <Field label="Category" value={product.data.category} />
                  <Field label="Brand" value={product.data.brand} />
                  <Field label="Barcode" value={product.data.barcode} />
                  <Field label="Weight" value={product.data.weight ? `${product.data.weight} kg` : null} />
                  <Field
                    label="Dimensions"
                    value={
                      product.data.length && product.data.width && product.data.height
                        ? `${product.data.length} x ${product.data.width} x ${product.data.height} cm`
                        : null
                    }
                  />
                  <Field label="Default cost" value={money(product.data.defaultCostCents)} />
                  <Field label="Default price" value={money(product.data.defaultPriceCents)} />
                  <Field label="Created" value={formatDate(product.data.createdAt)} />
                </SimpleGrid>
                {product.data.description && (
                  <Text size="sm" mt="md" c="dimmed">
                    {product.data.description}
                  </Text>
                )}
              </Card>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 8 }}>
              <Card withBorder radius="md" p="md" h="100%">
                <Group justify="space-between" mb="sm">
                  <Title order={5}>Stock by warehouse</Title>
                  <Text size="sm" c="dimmed">
                    {product.data.totalOnHand ?? 0} on hand · {product.data.totalAvailable ?? 0} available
                  </Text>
                </Group>
                <QueryState
                  isLoading={false}
                  error={null}
                  isEmpty={product.data.balances.length === 0}
                  emptyMessage="This product has no stock anywhere yet."
                >
                  <Table className="data-grid" verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Warehouse</Table.Th>
                        <Table.Th ta="right">On hand</Table.Th>
                        <Table.Th ta="right">Reserved</Table.Th>
                        <Table.Th ta="right">Incoming</Table.Th>
                        <Table.Th ta="right">Available</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {product.data.balances.map((b) => (
                        <Table.Tr key={b.id}>
                          <Table.Td>
                            <Anchor component={Link} to={`/warehouses/${b.warehouseId}`}>
                              {b.warehouse?.name ?? b.warehouseId}
                            </Anchor>
                          </Table.Td>
                          <Table.Td ta="right">{b.onHandQty}</Table.Td>
                          <Table.Td ta="right">{b.reservedQty}</Table.Td>
                          <Table.Td ta="right">{b.incomingQty}</Table.Td>
                          <Table.Td ta="right" fw={600}>
                            {b.availableQty}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </QueryState>
              </Card>
            </Grid.Col>

            <Grid.Col span={12}>
              <Card withBorder radius="md" p="md" mb="md">
                <Group justify="space-between" mb="sm">
                  <Title order={5}>Open FIFO cost layers</Title>
                  <Text size="xs" c="dimmed">
                    Oldest first — the order a sale will consume them in
                  </Text>
                </Group>
                <QueryState
                  isLoading={lots.isLoading}
                  error={lots.error}
                  isEmpty={(lots.data?.data.length ?? 0) === 0}
                  emptyMessage="No costed stock. Receive a purchase order or adjust stock in with a cost."
                  onRetry={lots.refetch}
                >
                  <Table className="data-grid" verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Received</Table.Th>
                        <Table.Th>Warehouse</Table.Th>
                        <Table.Th>Source</Table.Th>
                        <Table.Th ta="right">Unit cost</Table.Th>
                        <Table.Th ta="right">Remaining</Table.Th>
                        <Table.Th ta="right">Value</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {lots.data?.data.map((l) => (
                        <Table.Tr key={l.id}>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {formatDate(l.receivedAt)}
                            </Text>
                          </Table.Td>
                          <Table.Td>{l.warehouse?.code}</Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {l.sourceType.replaceAll("_", " ").toLowerCase()}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">{money(l.unitCostCents)}</Table.Td>
                          <Table.Td ta="right">
                            {l.remainingQty} / {l.originalQty}
                          </Table.Td>
                          <Table.Td ta="right" fw={600}>
                            {money(l.remainingValueCents)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </QueryState>
              </Card>

              <Card withBorder radius="md" p="md">
                <Title order={5} mb="sm">
                  Stock history
                </Title>
                <QueryState
                  isLoading={movements.isLoading}
                  error={movements.error}
                  isEmpty={(movements.data?.data.length ?? 0) === 0}
                  emptyMessage="No movements recorded for this product."
                >
                  <Table.ScrollContainer minWidth={720}>
                    <Table className="data-grid" verticalSpacing={6}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>When</Table.Th>
                          <Table.Th>Type</Table.Th>
                          <Table.Th>Route</Table.Th>
                          <Table.Th ta="right">Qty</Table.Th>
                          <Table.Th ta="right">Cost</Table.Th>
                          <Table.Th>Reason</Table.Th>
                          <Table.Th>Actor</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {movements.data?.data.map((m) => (
                          <Table.Tr key={m.id}>
                            <Table.Td>
                              <Text size="xs" c="dimmed">
                                {formatDate(m.createdAt)}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <StatusBadge value={m.movementType} />
                            </Table.Td>
                            <Table.Td>
                              <MovementRoute from={m.fromWarehouse} to={m.toWarehouse} />
                            </Table.Td>
                            <Table.Td ta="right">{m.quantity}</Table.Td>
                            <Table.Td ta="right">
                              {m.totalCostCents > 0 ? money(m.totalCostCents) : "—"}
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">{m.reason ?? "—"}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" c="dimmed">
                                {m.actor}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </QueryState>
              </Card>
            </Grid.Col>
          </Grid>
        )}
      </QueryState>
    </>
  );
}
