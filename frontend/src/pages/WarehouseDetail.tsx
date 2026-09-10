import {
  Anchor,
  Button,
  Card,
  Group,
  SimpleGrid,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type Balance, type Warehouse } from "../api";
import { PageHeader, QueryState, Stat } from "../components/ui";

type WarehouseDetailResponse = Warehouse & { balances: Balance[]; totalOnHand: number };

export default function WarehouseDetail() {
  const { id } = useParams();
  const warehouseId = Number(id);

  const { data, isLoading, error } = useQuery({
    queryKey: ["warehouse", warehouseId],
    queryFn: () => api.get<WarehouseDetailResponse>(`/warehouses/${warehouseId}`),
    enabled: Number.isFinite(warehouseId),
  });

  return (
    <>
      <PageHeader
        title={data ? `${data.name} (${data.code})` : "Warehouse"}
        subtitle={data?.address ?? undefined}
        action={
          <Button component={Link} to={`/transfers?from=${warehouseId}`} variant="light">
            New transfer from here
          </Button>
        }
      />

      <QueryState isLoading={isLoading} error={error}>
        {data && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }} mb="lg">
              <Stat label="Units on hand" value={data.totalOnHand} />
              <Stat
                label="SKUs stocked"
                value={data.balances.filter((b) => b.onHandQty !== 0).length}
              />
              <Stat label="Notes" value={data.notes ?? "—"} />
            </SimpleGrid>

            <Card withBorder radius="md" p="md">
              <Group justify="space-between" mb="sm">
                <Title order={5}>Inventory at this warehouse</Title>
              </Group>
              <QueryState
                isLoading={false}
                error={null}
                isEmpty={data.balances.length === 0}
                emptyMessage="Nothing is stocked here yet."
              >
                <Table.ScrollContainer minWidth={680}>
                  <Table className="data-grid" verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>SKU</Table.Th>
                        <Table.Th>Product</Table.Th>
                        <Table.Th ta="right">On hand</Table.Th>
                        <Table.Th ta="right">Reserved</Table.Th>
                        <Table.Th ta="right">Incoming</Table.Th>
                        <Table.Th ta="right">Available</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.balances.map((b) => (
                        <Table.Tr key={b.id}>
                          <Table.Td>
                            <Anchor component={Link} to={`/products/${b.productId}`}>{b.product?.sku}</Anchor>
                          </Table.Td>
                          <Table.Td>{b.product?.name}</Table.Td>
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
                </Table.ScrollContainer>
              </QueryState>
            </Card>
          </>
        )}
      </QueryState>
    </>
  );
}
