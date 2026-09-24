import {
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  SimpleGrid,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { api, type SalesOrder, type ShipmentOnOrder, openPdf } from "../api";
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

/**
 * Carrier, tracking number and delivery for one shipment.
 *
 * Separate from /ship on purpose, and the backend enforces the same split: the
 * number usually arrives after the van has gone, and recording it must never
 * touch stock or the ledger. The goods left when they left.
 *
 * Delivery is a checkbox rather than a date picker because it is an assertion
 * someone makes, not an observation Stockroom can perform — and an assertion
 * can be retracted, so unticking it clears the date.
 */
function ShipmentTracking({
  shipment,
  orderId,
}: {
  shipment: ShipmentOnOrder;
  orderId: number;
}) {
  const queryClient = useQueryClient();
  const [carrier, setCarrier] = useState(shipment.carrier ?? "");
  const [trackingNumber, setTrackingNumber] = useState(shipment.trackingNumber ?? "");

  const carriers = useQuery({
    queryKey: ["shipping-carriers"],
    queryFn: () => api.get<{ carriers: string[] }>("/sales-orders/shipping-carriers"),
    staleTime: Infinity,
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<ShipmentOnOrder>(`/sales-orders/shipments/${shipment.id}/tracking`, body),
    onSuccess: (_res, body) => {
      toastOk(
        "delivered" in body
          ? body.delivered
            ? "Marked delivered"
            : "Delivery mark removed"
          : "Tracking saved"
      );
      // Nothing here moves stock or money, so only the order and the delivery
      // list need refreshing — not the blanket invalidation the verbs use.
      queryClient.invalidateQueries({ queryKey: ["sales-order", orderId] });
      queryClient.invalidateQueries({ queryKey: ["deliveries"] });
    },
    onError: toastErr,
  });

  const dirty =
    carrier.trim() !== (shipment.carrier ?? "") ||
    trackingNumber.trim() !== (shipment.trackingNumber ?? "");

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" align="flex-start" mb="sm" wrap="wrap">
        <div>
          <Text fw={600}>{shipment.shipmentNumber}</Text>
          <Text size="xs" c="dimmed">
            Shipped {formatDate(shipment.shippedAt)}
          </Text>
        </div>
        <Group gap="xs">
          {shipment.deliveredAt ? (
            <Badge variant="light" color="teal">
              Delivered {formatDate(shipment.deliveredAt)}
            </Badge>
          ) : (
            <Badge variant="light" color="blue">
              In transit
            </Badge>
          )}
          <Anchor
            component="button"
            type="button"
            onClick={() => openPdf(`/sales-orders/shipments/${shipment.id}/packing-slip.pdf`).catch(toastErr)}
            size="xs"
            fw={500}
          >
            Packing slip
          </Anchor>
          <Anchor
            component="button"
            type="button"
            onClick={() => openPdf(`/sales-orders/shipments/${shipment.id}/label.pdf`).catch(toastErr)}
            size="xs"
            fw={500}
          >
            Label
          </Anchor>
        </Group>
      </Group>

      <Group align="flex-end" gap="sm" wrap="wrap">
        <Autocomplete
          label="Carrier"
          placeholder="UPS, FedEx, or type your own"
          data={carriers.data?.carriers ?? []}
          value={carrier}
          onChange={setCarrier}
          w={200}
        />
        <TextInput
          label="Tracking number"
          placeholder="The number the customer quotes"
          value={trackingNumber}
          onChange={(event) => setTrackingNumber(event.currentTarget.value)}
          w={260}
        />
        <Button
          variant="light"
          disabled={!dirty}
          loading={save.isPending && !("delivered" in (save.variables ?? {}))}
          onClick={() =>
            save.mutate({ carrier: carrier.trim(), trackingNumber: trackingNumber.trim() })
          }
        >
          Save tracking
        </Button>
        {shipment.trackingUrl && (
          <Anchor href={shipment.trackingUrl} target="_blank" rel="noreferrer" size="sm" pb={8}>
            Track with {shipment.carrier}
          </Anchor>
        )}
      </Group>

      <Divider my="sm" />

      <Switch
        checked={Boolean(shipment.deliveredAt)}
        onChange={(event) => save.mutate({ delivered: event.currentTarget.checked })}
        label="Customer has confirmed delivery"
        description="Stockroom cannot see a delivery. Ticking this records that somebody told us."
      />
    </Card>
  );
}

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
                  payment !== "AWAITING_PAYMENT" && payment !== "PREPAID"
                    ? `This order is already ${formatStatus(payment!).toLowerCase()}`
                    : !data.customerId
                      ? "An invoice needs a customer from the catalog"
                      : undefined
                }
              >
                {/* Shipping invoices the order by itself; this is billing ahead of it. */}
                Invoice before shipping
              </GatedButton>
              <GatedButton
                variant="light"
                onClick={() => action.mutate("pay")}
                loading={busy("pay")}
                reason={
                  readiness === "CANCELED"
                    ? "This order is canceled"
                    : payment === "PREPAID"
                      ? "Paid in full at checkout — shipping will invoice and settle it"
                      : payment === "PAID"
                        ? "This order is paid"
                        : payment === "VOIDED"
                          ? "This order's payment was voided"
                          : !data.customerId
                            ? "Taking payment needs a customer from the catalog"
                            : undefined
                }
              >
                {/* Before shipment the money is held as a customer deposit. */}
                {payment === "AWAITING_PAYMENT" ? "Take payment" : "Record payment"}
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
                  readiness === "SHIPPED" || readiness === "DELIVERED"
                    ? "A shipped order cannot be canceled"
                    : payment === "PREPAID" || (data.deposits?.length ?? 0) > 0
                      ? "This order holds a checkout payment — reverse it (refund) first"
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
                            <Table.Td ta="right" w={110}>
                              {/* Fetched with the session header: a plain link
                                  cannot send it, and answered 401. */}
                              <Anchor
                                component="button"
                                type="button"
                                onClick={() => openPdf(`/sales-orders/invoices/${inv.id}/pdf`).catch(toastErr)}
                                size="xs"
                                fw={500}
                              >
                                Open PDF
                              </Anchor>
                            </Table.Td>
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
                            <Table.Td ta="right" w={110}>
                              <Anchor
                                component="button"
                                type="button"
                                onClick={() => openPdf(`/sales-orders/shipments/${sh.id}/packing-slip.pdf`).catch(toastErr)}
                                size="xs"
                                fw={500}
                              >
                                Packing slip
                              </Anchor>
                            </Table.Td>
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

            {(data.shipments?.length ?? 0) > 0 && (
              <>
                <Title order={4} mt="xl" mb="sm">
                  Delivery
                </Title>
                <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                  {data.shipments?.map((shipment) => (
                    <ShipmentTracking
                      key={shipment.id}
                      shipment={shipment}
                      orderId={orderId}
                    />
                  ))}
                </SimpleGrid>
              </>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}
