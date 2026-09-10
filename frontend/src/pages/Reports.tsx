import {
  Alert,
  Card,
  Grid,
  Group,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  qs,
  type PurchaseReport,
  type SalesReport,
  type StockOnHandReport,
  type ValuationReport,
} from "../api";
import { PageHeader, QueryState, Stat, money } from "../components/ui";

/** A group row with a bar, so relative size reads without a chart library. */
function GroupTable({
  groups,
  total,
}: {
  groups: { label: string; totalCents: number; count: number }[];
  total: number;
}) {
  return (
    <Table className="data-grid" verticalSpacing={6}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Group</Table.Th>
          <Table.Th w={140}>Share</Table.Th>
          <Table.Th ta="right">Orders</Table.Th>
          <Table.Th ta="right">Amount</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {groups.map((g) => (
          <Table.Tr key={g.label}>
            <Table.Td>{g.label}</Table.Td>
            <Table.Td>
              <Progress
                value={total > 0 ? (g.totalCents / total) * 100 : 0}
                size="sm"
                radius="xl"
                aria-label={`${g.label} share`}
              />
            </Table.Td>
            <Table.Td ta="right">{g.count}</Table.Td>
            <Table.Td ta="right" fw={600}>
              {money(g.totalCents)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function Reports() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [salesGroup, setSalesGroup] = useState("customer");
  const [purchaseGroup, setPurchaseGroup] = useState("vendor");
  const [asOf, setAsOf] = useState("");

  const sales = useQuery({
    queryKey: ["report-sales", { from, to, salesGroup }],
    queryFn: () => api.get<SalesReport>(`/reports/sales${qs({ from, to, groupBy: salesGroup })}`),
  });
  const purchases = useQuery({
    queryKey: ["report-purchases", { from, to, purchaseGroup }],
    queryFn: () =>
      api.get<PurchaseReport>(`/reports/purchases${qs({ from, to, groupBy: purchaseGroup })}`),
  });
  const stock = useQuery({
    queryKey: ["report-stock", asOf],
    queryFn: () => api.get<StockOnHandReport>(`/reports/stock-on-hand${qs({ asOf })}`),
  });
  const valuation = useQuery({
    queryKey: ["report-valuation"],
    queryFn: () => api.get<ValuationReport>("/reports/inventory-valuation"),
  });

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Margin comes from the FIFO cost actually consumed, not an estimate."
        action={
          <Group gap="xs">
            <TextInput
              type="date"
              label="From"
              size="xs"
              value={from}
              onChange={(e) => setFrom(e.currentTarget.value)}
            />
            <TextInput
              type="date"
              label="To"
              size="xs"
              value={to}
              onChange={(e) => setTo(e.currentTarget.value)}
            />
          </Group>
        }
      />

      <Tabs defaultValue="sales">
        <Tabs.List mb="md">
          <Tabs.Tab value="sales">Sales</Tabs.Tab>
          <Tabs.Tab value="purchases">Purchases</Tabs.Tab>
          <Tabs.Tab value="stock">Stock on hand</Tabs.Tab>
          <Tabs.Tab value="valuation">Valuation</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="sales">
          <QueryState isLoading={sales.isLoading} error={sales.error} onRetry={sales.refetch}>
            {sales.data && (
              <>
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mb="md">
                  <Stat label="Orders" value={sales.data.orderCount} />
                  <Stat
                    label="Revenue"
                    value={money(sales.data.revenueCents)}
                    hint={
                      sales.data.taxAndShippingCents > 0
                        ? `goods only · ${money(sales.data.taxAndShippingCents)} tax & shipping`
                        : "goods value"
                    }
                  />
                  <Stat label="Cost of goods sold" value={money(sales.data.cogsCents)} hint="FIFO" />
                  <Stat
                    label="Gross profit"
                    value={money(sales.data.grossProfitCents)}
                    hint={
                      sales.data.revenueCents > 0
                        ? `${((sales.data.grossProfitCents / sales.data.revenueCents) * 100).toFixed(1)}% margin`
                        : undefined
                    }
                  />
                </SimpleGrid>

                <Card withBorder radius="md" p="md">
                  <Group justify="space-between" mb="sm">
                    <Title order={5}>Revenue by</Title>
                    <SegmentedControl
                      size="xs"
                      value={salesGroup}
                      onChange={setSalesGroup}
                      data={[
                        { value: "customer", label: "Customer" },
                        { value: "employee", label: "Manager" },
                        { value: "category", label: "Category" },
                        { value: "channel", label: "Channel" },
                      ]}
                    />
                  </Group>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={sales.data.groups.length === 0}
                    emptyMessage="No invoiced orders in this period."
                  >
                    <GroupTable groups={sales.data.groups} total={sales.data.revenueCents} />
                  </QueryState>
                </Card>
              </>
            )}
          </QueryState>
        </Tabs.Panel>

        <Tabs.Panel value="purchases">
          <QueryState
            isLoading={purchases.isLoading}
            error={purchases.error}
            onRetry={purchases.refetch}
          >
            {purchases.data && (
              <>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mb="md">
                  <Stat label="Purchase orders" value={purchases.data.orderCount} />
                  <Stat label="Committed spend" value={money(purchases.data.spendCents)} />
                </SimpleGrid>
                <Card withBorder radius="md" p="md">
                  <Group justify="space-between" mb="sm">
                    <Title order={5}>Spend by</Title>
                    <SegmentedControl
                      size="xs"
                      value={purchaseGroup}
                      onChange={setPurchaseGroup}
                      data={[
                        { value: "vendor", label: "Vendor" },
                        { value: "category", label: "Category" },
                      ]}
                    />
                  </Group>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={purchases.data.groups.length === 0}
                    emptyMessage="No posted purchase orders in this period."
                  >
                    <GroupTable groups={purchases.data.groups} total={purchases.data.spendCents} />
                  </QueryState>
                </Card>
              </>
            )}
          </QueryState>
        </Tabs.Panel>

        <Tabs.Panel value="stock">
          <Card withBorder radius="md" p="md">
            <Group justify="space-between" mb="sm">
              <div>
                <Title order={5}>Stock on a selected date</Title>
                <Text size="xs" c="dimmed">
                  Replayed from the movement ledger, so it stays correct after the fact.
                </Text>
              </div>
              <TextInput
                type="date"
                label="As of"
                size="xs"
                value={asOf}
                onChange={(e) => setAsOf(e.currentTarget.value)}
              />
            </Group>
            <QueryState
              isLoading={stock.isLoading}
              error={stock.error}
              isEmpty={(stock.data?.rows.length ?? 0) === 0}
              emptyMessage="No stock had been recorded by that date."
              onRetry={stock.refetch}
            >
              {stock.data && (
                <>
                  <Group mb="sm" gap="xl">
                    <Text size="sm" c="dimmed">
                      {stock.data.movementsReplayed} movements replayed
                    </Text>
                    <Text size="sm">
                      <strong>{stock.data.totalQuantity.toLocaleString()}</strong> units
                    </Text>
                    <Text size="sm">
                      valued at <strong>{money(stock.data.totalCostCents)}</strong>
                    </Text>
                  </Group>
                  <Table.ScrollContainer minWidth={560}>
                    <Table className="data-grid" verticalSpacing={6}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>SKU</Table.Th>
                          <Table.Th>Product</Table.Th>
                          <Table.Th>Warehouse</Table.Th>
                          <Table.Th ta="right">Quantity</Table.Th>
                          <Table.Th ta="right">Cost</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {stock.data.rows.map((r) => (
                          <Table.Tr key={`${r.sku}:${r.warehouseCode}`}>
                            <Table.Td>{r.sku}</Table.Td>
                            <Table.Td>{r.productName}</Table.Td>
                            <Table.Td>{r.warehouseCode}</Table.Td>
                            <Table.Td ta="right">{r.quantity}</Table.Td>
                            <Table.Td ta="right">{money(r.costCents)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </>
              )}
            </QueryState>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel value="valuation">
          <QueryState
            isLoading={valuation.isLoading}
            error={valuation.error}
            onRetry={valuation.refetch}
          >
            {valuation.data && (
              <>
                <Alert
                  mb="md"
                  color={valuation.data.reconciled ? "teal" : "red"}
                  icon={
                    valuation.data.reconciled ? (
                      <IconCheck size={18} />
                    ) : (
                      <IconAlertTriangle size={18} />
                    )
                  }
                  title={
                    valuation.data.reconciled
                      ? "Stock value reconciles with the Inventory account"
                      : `Variance of ${money(valuation.data.varianceCents)}`
                  }
                >
                  <Text size="sm">
                    {/* Only spell out the sum when there is something in
                        transit to add — otherwise it reads "X = X". */}
                    {valuation.data.inTransitCents > 0 ? (
                      <>
                        FIFO layers {money(valuation.data.layerValueCents)} plus{" "}
                        {money(valuation.data.inTransitCents)} in transit ={" "}
                        {money(valuation.data.assetValueCents)}, against a ledger balance of{" "}
                        {money(valuation.data.ledgerValueCents)}.
                      </>
                    ) : (
                      <>
                        FIFO layers total {money(valuation.data.assetValueCents)}, against a ledger
                        balance of {money(valuation.data.ledgerValueCents)}.
                      </>
                    )}{" "}
                    {valuation.data.reconciled
                      ? "Costing and accounting agree to the cent."
                      : "They have drifted apart — a stock movement changed quantity without its matching posting."}
                  </Text>
                  {valuation.data.inTransitCents > 0 && (
                    <Text size="xs" c="dimmed" mt={4}>
                      Stock in transit has left its source warehouse and not yet arrived, so it
                      belongs to neither — but it is still an asset on the books.
                    </Text>
                  )}
                </Alert>

                <SimpleGrid cols={{ base: 1, sm: 3 }} mb="md">
                  <Stat label="In warehouses" value={money(valuation.data.layerValueCents)} />
                  <Stat
                    label="In transit"
                    value={money(valuation.data.inTransitCents)}
                    hint="owned by neither warehouse"
                  />
                  <Stat label="Total stock asset" value={money(valuation.data.assetValueCents)} />
                </SimpleGrid>

                <Card withBorder radius="md" p="md">
                  <Title order={5} mb="sm">
                    Value by product and warehouse
                  </Title>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={valuation.data.rows.length === 0}
                    emptyMessage="No open cost layers."
                  >
                    <Table.ScrollContainer minWidth={620}>
                      <Table className="data-grid" verticalSpacing={6}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>SKU</Table.Th>
                            <Table.Th>Product</Table.Th>
                            <Table.Th>Warehouse</Table.Th>
                            <Table.Th ta="right">Qty</Table.Th>
                            <Table.Th ta="right">Layers</Table.Th>
                            <Table.Th ta="right">Value</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {valuation.data.rows.map((r) => (
                            <Table.Tr key={`${r.sku}:${r.warehouseCode}`}>
                              <Table.Td>{r.sku}</Table.Td>
                              <Table.Td>{r.name}</Table.Td>
                              <Table.Td>{r.warehouseCode}</Table.Td>
                              <Table.Td ta="right">{r.quantity}</Table.Td>
                              <Table.Td ta="right">{r.layers}</Table.Td>
                              <Table.Td ta="right" fw={600}>
                                {money(r.valueCents)}
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </QueryState>
                </Card>
              </>
            )}
          </QueryState>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
