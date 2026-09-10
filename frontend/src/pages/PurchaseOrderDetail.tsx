import { Anchor, Card, Divider, Grid, Group, SimpleGrid, Table, Text, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type PurchaseOrder } from "../api";
import { GatedButton } from "../components/GatedButton";
import {
  PageHeader,
  QueryState,
  Stat,
  StatusBadge,
  formatDate,
  formatStatus,
  money,
  toastErr,
  toastOk,
} from "../components/ui";

type Verb = "post" | "pay" | "receive" | "cancel" | "void-bill";

export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const orderId = Number(id);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["purchase-order", orderId],
    queryFn: () => api.get<PurchaseOrder>(`/purchase-orders/${orderId}`),
    enabled: Number.isFinite(orderId),
  });

  const action = useMutation({
    mutationFn: (verb: Verb) => api.post<unknown>(`/purchase-orders/${orderId}/${verb}`),
    onSuccess: (_res, verb) => {
      toastOk(
        verb === "void-bill"
          ? "Bill voided — its posting was reversed with a contra entry"
          : `Purchase order ${verb === "pay" ? "paid" : verb === "receive" ? "received" : `${verb}ed`}`
      );
      // A posting changes stock, the ledger and every report at once.
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const status = data?.status;
  const busy = (verb: Verb) => action.isPending && action.variables === verb;

  return (
    <>
      <PageHeader
        title={data ? data.poNumber : "Purchase order"}
        subtitle={data ? data.supplierName : undefined}
        action={
          data && (
            <Group gap="xs">
              <GatedButton
                onClick={() => action.mutate("post")}
                loading={busy("post")}
                reason={
                  status !== "SAVED"
                    ? `Only a saved purchase order can be posted — this one is ${formatStatus(status!).toLowerCase()}`
                    : !data.vendorId
                      ? "A vendor bill needs a vendor from the catalog"
                      : undefined
                }
              >
                Post (create bill)
              </GatedButton>
              <GatedButton
                variant="light"
                onClick={() => action.mutate("pay")}
                loading={busy("pay")}
                reason={
                  status !== "POSTED" && status !== "DELIVERED"
                    ? `Only a posted or delivered purchase order can be paid — this one is ${formatStatus(status!).toLowerCase()}`
                    : (data.bills ?? []).every((b) => b.status !== "POSTED")
                      ? "There is no posted bill to pay"
                      : undefined
                }
              >
                Pay vendor
              </GatedButton>
              <GatedButton
                color="teal.9"
                onClick={() => action.mutate("receive")}
                loading={busy("receive")}
                reason={
                  status !== "POSTED" && status !== "PAID"
                    ? `Only a posted or paid purchase order can be received — this one is ${formatStatus(status!).toLowerCase()}`
                    : undefined
                }
              >
                Receive (GRN)
              </GatedButton>
              {status === "POSTED" && (
                <GatedButton
                  variant="light"
                  color="orange"
                  onClick={() => action.mutate("void-bill")}
                  loading={busy("void-bill")}
                >
                  Void bill
                </GatedButton>
              )}
              <GatedButton
                variant="default"
                onClick={() => action.mutate("cancel")}
                loading={busy("cancel")}
                reason={
                  status === "DELIVERED"
                    ? "A delivered purchase order cannot be canceled"
                    : status === "CANCELED"
                      ? "This purchase order is already canceled"
                      : status === "PAID"
                        ? "This purchase order is paid — void the payment first"
                        : status === "POSTED"
                          ? "This purchase order has a posted bill — void the bill first"
                          : undefined
                }
              >
                Cancel
              </GatedButton>
            </Group>
          )
        }
      />

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {data && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mb="md">
              <Stat label="Status" value={<StatusBadge value={data.status} />} />
              <Stat
                label="Order total"
                value={money(data.totalCents)}
                hint={`${data.totalQuantity ?? 0} units`}
              />
              <Stat label="Created" value={formatDate(data.createdAt)} hint={data.employee?.name} />
            </SimpleGrid>

            <Grid>
              <Grid.Col span={{ base: 12, lg: 8 }}>
                <Card withBorder radius="md" p="md">
                  <Title order={5} mb="sm">
                    Line items
                  </Title>
                  <Table className="data-grid" verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>SKU</Table.Th>
                        <Table.Th>Product</Table.Th>
                        <Table.Th>Warehouse</Table.Th>
                        <Table.Th ta="right">Qty</Table.Th>
                        <Table.Th ta="right">Unit cost</Table.Th>
                        <Table.Th ta="right">Line total</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.lines.map((l) => (
                        <Table.Tr key={l.id}>
                          <Table.Td>
                            <Anchor component={Link} to={`/products/${l.productId}`} size="sm">
                              {l.product?.sku}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>{l.product?.name}</Table.Td>
                          <Table.Td>{l.warehouse?.code}</Table.Td>
                          <Table.Td ta="right">{l.quantity}</Table.Td>
                          <Table.Td ta="right">{money(l.unitCostCents)}</Table.Td>
                          <Table.Td ta="right" fw={600}>
                            {money(l.lineTotalCents)}
                          </Table.Td>
                          <Table.Td>
                            <StatusBadge value={l.status} />
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>

                  <Divider my="sm" />
                  <Group justify="flex-end" gap="xl">
                    <Text size="sm" c="dimmed">
                      Subtotal {money(data.subtotalCents)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      Tax {money(data.taxCents)}
                    </Text>
                    <Text size="sm" fw={700}>
                      Total {money(data.totalCents)}
                    </Text>
                  </Group>
                </Card>
              </Grid.Col>

              <Grid.Col span={{ base: 12, lg: 4 }}>
                <Card withBorder radius="md" p="md" h="100%">
                  <Title order={5} mb="sm">
                    Documents
                  </Title>
                  <QueryState
                    isLoading={false}
                    error={null}
                    isEmpty={(data.bills?.length ?? 0) + (data.goodsReceipts?.length ?? 0) === 0}
                    emptyMessage="Nothing posted yet. Posting creates a bill; receiving creates a goods receipt."
                  >
                    <Table verticalSpacing={6}>
                      <Table.Tbody>
                        {data.bills?.map((b) => (
                          <Table.Tr key={`b${b.id}`}>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {b.billNumber}
                              </Text>
                              <Text size="xs" c="dimmed">
                                Invoice
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">{money(b.totalCents)}</Table.Td>
                          </Table.Tr>
                        ))}
                        {data.goodsReceipts?.map((g) => (
                          <Table.Tr key={`g${g.id}`}>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {g.grnNumber}
                              </Text>
                              <Text size="xs" c="dimmed">
                                Goods receipt
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">{money(g.totalCostCents)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
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
