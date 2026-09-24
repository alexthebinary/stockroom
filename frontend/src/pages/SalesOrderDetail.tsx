import {
  Anchor,
  Menu,
  Autocomplete,
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, type SalesOrder, type ShipmentOnOrder, openPdf } from "../api";
import { GatedButton } from "../components/GatedButton";
import { ReturnItemsModal } from "../components/ReturnItemsModal";
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

  // A showroom sale is collected over the counter: offering tracking and a
  // "customer confirmed delivery" toggle for it asked a question with no answer.
  if (shipment.carrier === "Collected in store") {
    return (
      <Card withBorder radius="md" p="md">
        <Text fw={600}>{shipment.shipmentNumber}</Text>
        <Text size="sm" c="dimmed">
          Collected in store · {formatDate(shipment.shippedAt)}
        </Text>
      </Card>
    );
  }

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
        description="ProfitIndex cannot see a delivery. Ticking this records that somebody told us."
      />
    </Card>
  );
}

type OrderAction = {
  key: string;
  label: string;
  run: () => void;
  /** Why it cannot be used right now; unset means available. */
  reason?: string;
  loading?: boolean;
  /** Undoing or destructive: never a headline button, always behind More. */
  secondary?: boolean;
  color?: string;
};

/**
 * The order's actions, shown by what is possible NOW.
 *
 * The toolbar used to show all six actions whatever the state, so a delivered,
 * paid order offered Pack, Invoice, Take payment, Ship and Cancel greyed or
 * half-greyed around the one thing you could do, and wrapped to three rows on
 * a phone. Now: what is available is a button (the first one filled); what is
 * undoing or unavailable waits under More, with its reason written out — a
 * hover-only tooltip never reached a tablet (critique 2026-09-24).
 */
function OrderActions({ actions }: { actions: OrderAction[] }) {
  const live = actions.filter((a) => !a.reason && !a.secondary);
  const more = actions.filter((a) => a.reason || a.secondary);
  return (
    <Group gap="xs" wrap="wrap">
      {live.map((a, i) => (
        <Button
          key={a.key}
          variant={i === 0 ? "filled" : "light"}
          color={a.color}
          loading={a.loading}
          onClick={a.run}
        >
          {a.label}
        </Button>
      ))}
      {more.length > 0 && (
        <Menu position="bottom-end" withArrow shadow="md" width={280}>
          <Menu.Target>
            <Button variant="default" rightSection={<IconChevronDown size={14} />}>
              More
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {more.map((a) => (
              <Menu.Item
                key={a.key}
                disabled={Boolean(a.reason)}
                color={!a.reason && a.color ? a.color : undefined}
                onClick={a.reason ? undefined : a.run}
              >
                <Text size="sm" fw={500}>
                  {a.label}
                </Text>
                {a.reason && (
                  <Text size="xs" c="dimmed">
                    {a.reason}
                  </Text>
                )}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}

export default function SalesOrderDetail() {
  const { id } = useParams();
  const orderId = Number(id);
  const queryClient = useQueryClient();
  const [returnOpen, setReturnOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sales-order", orderId],
    queryFn: () => api.get<SalesOrder>(`/sales-orders/${orderId}`),
    enabled: Number.isFinite(orderId),
  });

  useEffect(() => {
    if (data?.orderNumber) document.title = `${data.orderNumber} · ProfitIndex`;
  }, [data?.orderNumber]);

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

  const orderActions = (order: SalesOrder): OrderAction[] => {
    const shipped = readiness === "SHIPPED" || readiness === "DELIVERED";
    return [
      {
        key: "pack",
        label: "Pack (reserve stock)",
        run: () => action.mutate("pack"),
        loading: busy("pack"),
        reason: readiness !== "NOT_PACKED" ? `Already ${formatStatus(readiness!).toLowerCase()}` : undefined,
      },
      {
        key: "pay",
        // It RECORDS money received; nothing here charges a card.
        label: payment === "AWAITING_PAYMENT" ? "Record checkout payment" : "Record payment",
        run: () => action.mutate("pay"),
        loading: busy("pay"),
        reason:
          readiness === "CANCELED"
            ? "This order is canceled"
            : payment === "PREPAID"
              ? "Paid in full at checkout — shipping will invoice and settle it"
              : payment === "PAID"
                ? "This order is paid"
                : payment === "VOIDED"
                  ? "This order's payment was voided"
                  : !order.customerId
                    ? "Needs a customer from the catalog"
                    : undefined,
      },
      {
        key: "ship",
        label: "Ship",
        color: "teal.9",
        run: () => action.mutate("ship"),
        loading: busy("ship"),
        reason: readiness !== "PACKED" ? (shipped ? "Already shipped" : "Pack it first") : undefined,
      },
      {
        key: "return",
        label: "Return items",
        color: "orange",
        run: () => setReturnOpen(true),
        reason: !shipped
          ? "Only shipped goods can be returned"
          : !order.invoices?.some((i) => i.status === "POSTED")
            ? "Invoice this order first — a return credits its invoice"
            : order.lines.every((l) => (l.returnedQty ?? 0) >= l.quantity)
              ? "Everything on this order has already been returned"
              : undefined,
      },
      {
        key: "invoice",
        label: "Invoice before shipping",
        secondary: true,
        run: () => action.mutate("invoice"),
        loading: busy("invoice"),
        reason:
          payment !== "AWAITING_PAYMENT" && payment !== "PREPAID"
            ? `Already ${formatStatus(payment!).toLowerCase()}`
            : !order.customerId
              ? "Needs a customer from the catalog"
              : undefined,
      },
      {
        key: "void",
        label: "Void invoice",
        secondary: true,
        color: "red",
        run: () => action.mutate("void-invoice"),
        loading: busy("void-invoice"),
        reason: payment !== "INVOICED" ? "Only an invoiced, unpaid order's invoice can be voided" : undefined,
      },
      {
        key: "cancel",
        label: "Cancel order",
        secondary: true,
        color: "red",
        run: () => action.mutate("cancel"),
        loading: busy("cancel"),
        reason: shipped
          ? "A shipped order cannot be canceled — use Return items"
          : payment === "PREPAID" || (order.deposits?.length ?? 0) > 0
            ? "It holds a checkout payment — reverse (refund) that first"
            : readiness === "CANCELED"
              ? "Already canceled"
              : payment === "PAID"
                ? "It is paid — reverse the payment first"
                : payment === "INVOICED"
                  ? "It is invoiced — void the invoice first"
                  : undefined,
      },
    ];
  };

  return (
    <>
      <PageHeader
        title={data ? data.orderNumber : "Sales order"}
        subtitle={data ? `${data.customerName} · ${data.channel}` : undefined}
        action={data && <OrderActions actions={orderActions(data)} />}
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
                hint={(() => {
                  const units = data.totalQuantity ?? 0;
                  const base = `${units} ${units === 1 ? "unit" : "units"}`;
                  const credited = (data.returns ?? []).reduce((s, r) => s + r.creditCents, 0);
                  // After a return the original total is still the right headline
                  // (it is what was invoiced), but it must not read as the net.
                  return credited > 0 ? `${base} · ${money(credited)} credited back` : base;
                })()}
              />
              <Stat label="Created" value={formatDate(data.createdAt)} hint={data.employee?.name} />
            </SimpleGrid>

            <Grid>
              <Grid.Col span={{ base: 12, lg: 8 }}>
                <Card withBorder radius="md" p="md">
                  <Title order={5} mb="sm">
                    Line items
                  </Title>
                  {/* Scrolls sideways on a phone instead of clipping: the card was
                      overflow-hidden at 340px and hid Line total and Status. */}
                  <Table.ScrollContainer minWidth={560}>
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
                  </Table.ScrollContainer>

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
                            Gross margin (ex-tax{data.margin && data.margin.returnedCents > 0 ? ", after returns" : ""})
                          </Text>
                          <Text size="sm" fw={700}>
                            {money(data.margin?.marginCents ?? 0)}
                          </Text>
                        </Group>
                      </>
                    )}
                  </QueryState>
                </Card>
              </Grid.Col>
            </Grid>

            {(data.returns?.length ?? 0) > 0 && (
              <>
                <Title order={4} mt="xl" mb="sm">
                  Returns
                </Title>
                <Card withBorder radius="md" p="md">
                  <Stack gap="xs">
                    {data.returns?.map((r) => (
                      <Group key={r.id} justify="space-between" wrap="wrap">
                        <Stack gap={0}>
                          <Text fw={600} size="sm">
                            {r.returnNumber} · {(() => {
                              const n = r.lines.reduce((s, l) => s + l.quantity, 0);
                              return `${n} ${n === 1 ? "unit" : "units"}`;
                            })()}
                            {r.lines.some((l) => l.disposition === "WRITE_OFF") && " · includes write-off"}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {r.reason} · {formatDate(r.createdAt)}
                          </Text>
                        </Stack>
                        <Text size="sm">
                          {money(r.creditCents)} credited
                          {r.refundCents > 0 && ` · ${money(r.refundCents)} refunded (${formatStatus(r.refundMethod ?? "")})`}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </Card>
              </>
            )}

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
            <ReturnItemsModal order={data} opened={returnOpen} onClose={() => setReturnOpen(false)} />
          </>
        )}
      </QueryState>
    </>
  );
}
