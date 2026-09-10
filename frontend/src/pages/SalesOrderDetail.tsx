import { Anchor, Card, Divider, Grid, Group, SimpleGrid, Table, Text, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type SalesOrder } from "../api";
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

type Verb = "pack" | "invoice" | "pay" | "ship" | "cancel" | "void-invoice";

export default function SalesOrderDetail() {
  const { id } = useParams();
  const orderId = Number(id);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sales-order", orderId],
    queryFn: () => api.get<SalesOrder>(`/sales-orders/${orderId}`),
    enabled: Number.isFinite(orderId),
  });

  const action = useMutation({
    mutationFn: (verb: Verb) => api.post<unknown>(`/sales-orders/${orderId}/${verb}`),
    onSuccess: (_res, verb) => {
      toastOk(
        verb === "void-invoice"
          ? "Invoice voided — its revenue was reversed with a contra entry"
          : `Order ${verb === "pay" ? "paid" : `${verb}${verb.endsWith("e") ? "d" : "ed"}`}`
      );
      // A posting changes stock, the ledger and every report at once.
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const readiness = data?.readinessStatus;
  const payment = data?.paymentStatus;
  const busy = (verb: Verb) => action.isPending && action.variables === verb;

  return (
    <>
      <PageHeader
        title={data ? data.orderNumber : "Sales order"}
        subtitle={data ? `${data.customerName} · ${data.channel}` : undefined}
        action={
          data && (
            <Group gap="xs">
              <GatedButton
                onClick={() => action.mutate("pack")}
                loading={busy("pack")}
                reason={
                  readiness !== "NOT_PACKED"
                    ? `Only an unpacked order can be packed — this one is ${formatStatus(readiness!).toLowerCase()}`
                    : undefined
                }
              >
                Pack (reserve)
              </GatedButton>
              <GatedButton
                variant="light"
                onClick={() => action.mutate("invoice")}
                loading={busy("invoice")}
                reason={
                  payment !== "AWAITING_PAYMENT"
                    ? `This order is already ${formatStatus(payment!).toLowerCase()}`
                    : !data.customerId
                      ? "An invoice needs a customer from the catalog"
                      : undefined
                }
              >
                Invoice
              </GatedButton>
              <GatedButton
                variant="light"
                onClick={() => action.mutate("pay")}
                loading={busy("pay")}
                reason={
                  payment !== "INVOICED"
                    ? `Only an invoiced order can be paid — this one is ${formatStatus(payment!).toLowerCase()}`
                    : undefined
                }
              >
                Record payment
              </GatedButton>
              <GatedButton
                color="teal.9"
                onClick={() => action.mutate("ship")}
                loading={busy("ship")}
                reason={
                  readiness !== "PACKED"
                    ? `Only a packed order can ship — this one is ${formatStatus(readiness!).toLowerCase()}`
                    : undefined
                }
              >
                Ship
              </GatedButton>
              {payment === "INVOICED" && (
                <GatedButton
                  variant="light"
                  color="orange"
                  onClick={() => action.mutate("void-invoice")}
                  loading={busy("void-invoice")}
                >
                  Void invoice
                </GatedButton>
              )}
              <GatedButton
                variant="default"
                onClick={() => action.mutate("cancel")}
                loading={busy("cancel")}
                reason={
                  readiness === "SHIPPED"
                    ? "A shipped order cannot be canceled"
                    : readiness === "CANCELED"
                      ? "This order is already canceled"
                      : payment === "PAID"
                        ? "This order is paid — refund and void the payment first"
                        : payment === "INVOICED"
                          ? "This order is invoiced — void the invoice first so its revenue is reversed"
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
              <Stat label="Delivery" value={<StatusBadge value={data.readinessStatus} />} />
              <Stat label="Payment" value={<StatusBadge value={data.paymentStatus} />} />
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
                        <Table.Th ta="right">Unit price</Table.Th>
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
                          <Table.Td ta="right">{money(l.unitPriceCents)}</Table.Td>
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
                    isEmpty={(data.invoices?.length ?? 0) + (data.shipments?.length ?? 0) === 0}
                    emptyMessage="Nothing posted yet. Invoicing and shipping each create a document."
                  >
                    <Table verticalSpacing={6}>
                      <Table.Tbody>
                        {data.invoices?.map((inv) => (
                          <Table.Tr key={`i${inv.id}`}>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {inv.invoiceNumber}
                              </Text>
                              <Text size="xs" c="dimmed">
                                Invoice
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">{money(inv.totalCents)}</Table.Td>
                          </Table.Tr>
                        ))}
                        {data.shipments?.map((sh) => (
                          <Table.Tr key={`s${sh.id}`}>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {sh.shipmentNumber}
                              </Text>
                              <Text size="xs" c="dimmed">
                                Shipment · COGS
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right">{money(sh.cogsCents)}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>

                    {(data.shipments?.length ?? 0) > 0 && (
                      <>
                        <Divider my="sm" />
                        <Group justify="space-between">
                          <Text size="sm" c="dimmed">
                            Gross margin
                          </Text>
                          <Text size="sm" fw={700}>
                            {money(
                              data.totalCents -
                                (data.shipments ?? []).reduce((s, sh) => s + sh.cogsCents, 0)
                            )}
                          </Text>
                        </Group>
                      </>
                    )}
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
