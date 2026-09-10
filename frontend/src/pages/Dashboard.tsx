import {
  Anchor,
  Card,
  Grid,
  Group,
  NumberInput,
  SimpleGrid,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type DashboardSummary, type ValuationReport } from "../api";
import { MovementRoute, PageHeader, QueryState, Stat, StatusBadge, formatDate, money } from "../components/ui";

export default function Dashboard() {
  const [threshold, setThreshold] = useState<number>(10);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard", threshold],
    queryFn: () => api.get<DashboardSummary>(`/dashboard${qs({ lowStockThreshold: threshold })}`),
  });

  // Stock value comes from the FIFO layers, not a quantity times a guess.
  const valuation = useQuery({
    queryKey: ["report-valuation"],
    queryFn: () => api.get<ValuationReport>("/reports/inventory-valuation"),
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Stock position across every warehouse, and what moved most recently."
        action={
          <NumberInput
            label="Low-stock threshold"
            value={threshold}
            onChange={(v) => setThreshold(Number(v) || 0)}
            min={0}
            w={170}
            size="xs"
          />
        }
      />

      <QueryState isLoading={isLoading} error={error}>
        {data && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="lg">
              <Stat
                label="SKUs"
                value={data.totals.productCount}
                hint={`${data.totals.activeProductCount} active`}
              />
              <Stat
                label="On hand"
                value={data.totals.onHandUnits}
                hint={`${data.totals.availableUnits.toLocaleString()} available`}
              />
              <Stat
                label="Reserved"
                value={data.totals.reservedUnits}
                hint={`${data.totals.openSalesOrders} open sales orders`}
              />
              <Stat
                label="Incoming"
                value={data.totals.incomingUnits}
                hint={`${data.totals.openPurchaseOrders} open purchase orders`}
              />
              <Stat
                label="Stock value"
                value={money(valuation.data?.layerValueCents ?? 0)}
                hint={
                  valuation.data
                    ? valuation.data.reconciled
                      ? "reconciled with the ledger"
                      : `variance ${money(valuation.data.varianceCents)}`
                    : "FIFO cost layers"
                }
              />
            </SimpleGrid>

            <Grid>
              <Grid.Col span={{ base: 12, lg: 6 }}>
                <Card withBorder radius="md" p="md" h="100%">
                  <Group justify="space-between" mb="sm">
                    <Title order={5}>Low stock</Title>
                    <Text size="xs" c="dimmed">
                      on hand below {data.lowStockThreshold}
                    </Text>
                  </Group>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={data.lowStock.length === 0}
                    emptyMessage="No SKU is below the threshold."
                  >
                    <Table.ScrollContainer minWidth={420}>
                      <Table className="data-grid" verticalSpacing={6}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>SKU</Table.Th>
                            <Table.Th>Warehouse</Table.Th>
                            <Table.Th ta="right">On hand</Table.Th>
                            <Table.Th ta="right">Available</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {data.lowStock.map((b) => (
                            <Table.Tr key={b.id}>
                              <Table.Td>
                                <Anchor component={Link} to={`/products/${b.productId}`}>{b.product?.sku}</Anchor>
                                <Text size="xs" c="dimmed">
                                  {b.product?.name}
                                </Text>
                              </Table.Td>
                              <Table.Td>{b.warehouse?.code}</Table.Td>
                              <Table.Td ta="right">{b.onHandQty}</Table.Td>
                              <Table.Td ta="right">{b.availableQty}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </QueryState>
                </Card>
              </Grid.Col>

              <Grid.Col span={{ base: 12, lg: 6 }}>
                <Card withBorder radius="md" p="md" h="100%">
                  <Title order={5} mb="sm">
                    Recent stock movements
                  </Title>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={data.recentMovements.length === 0}
                    emptyMessage="No movements recorded yet."
                  >
                    <Table.ScrollContainer minWidth={480}>
                      <Table className="data-grid" verticalSpacing={6}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Product</Table.Th>
                            <Table.Th>Type</Table.Th>
                            <Table.Th>Route</Table.Th>
                            <Table.Th ta="right">Qty</Table.Th>
                            <Table.Th>When</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {data.recentMovements.map((m) => (
                            <Table.Tr key={m.id}>
                              <Table.Td>
                                <Anchor component={Link} to={`/products/${m.productId}`}>{m.product?.sku}</Anchor>
                              </Table.Td>
                              <Table.Td>
                                <StatusBadge value={m.movementType} />
                              </Table.Td>
                              <Table.Td>
                                <MovementRoute from={m.fromWarehouse} to={m.toWarehouse} />
                              </Table.Td>
                              <Table.Td ta="right">{m.quantity}</Table.Td>
                              <Table.Td>
                                <Text size="xs" c="dimmed">
                                  {formatDate(m.createdAt)}
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
          </>
        )}
      </QueryState>
    </>
  );
}
