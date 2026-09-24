import {
  Anchor,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Progress,
  SimpleGrid,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (data?.poNumber) document.title = `${data.poNumber} · ProfitIndex`;
  }, [data?.poNumber]);

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

  // --- receiving -----------------------------------------------------------
  // A delivery is per line and per quantity, because suppliers under-ship and
  // back-order. The dialog opens pre-filled with everything outstanding, so
  // the common case — it all turned up — is still one click.
  const [receiveOpen, receive] = useDisclosure(false);
  const [counts, setCounts] = useState<Record<number, number | "">>({});

  const outstandingOf = (line: { quantity: number; receivedQty?: number }) =>
    line.quantity - (line.receivedQty ?? 0);

  const openReceive = () => {
    const next: Record<number, number | ""> = {};
    for (const line of data?.lines ?? []) next[line.id] = outstandingOf(line);
    setCounts(next);
    receive.open();
  };

  const receiveMutation = useMutation({
    mutationFn: () =>
      api.post<{ complete: boolean; goodsReceipt: { grnNumber: string } }>(
        `/purchase-orders/${orderId}/receive`,
        {
          lines: (data?.lines ?? []).map((l) => ({
            lineId: l.id,
            quantity: Number(counts[l.id] || 0),
          })),
        }
      ),
    onSuccess: (res) => {
      toastOk(
        res.complete
          ? `${res.goodsReceipt.grnNumber} received — the order is complete`
          : `${res.goodsReceipt.grnNumber} received — the order is still short`
      );
      receive.close();
      queryClient.invalidateQueries();
    },
    onError: toastErr,
  });

  const receivingTotal = (data?.lines ?? []).reduce(
    (sum, l) => sum + Number(counts[l.id] || 0),
    0
  );
  const anyOutstanding = (data?.lines ?? []).some((l) => outstandingOf(l) > 0);

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
                onClick={openReceive}
                reason={
                  status !== "POSTED" && status !== "PAID"
                    ? `Only a posted or paid purchase order can be received — this one is ${formatStatus(status!).toLowerCase()}`
                    : !anyOutstanding
                      ? "Everything on this order has already been received"
                      : undefined
                }
              >
                Receive
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
                        <Table.Th ta="right">Received</Table.Th>
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
                          <Table.Td ta="right">
                            {/* Short deliveries are ordinary, so the shortfall
                                is stated rather than left to subtraction. */}
                            <Text span fw={(l.receivedQty ?? 0) < l.quantity ? 700 : 400}>
                              {l.receivedQty ?? 0}
                            </Text>
                            {(l.receivedQty ?? 0) < l.quantity && (
                              <Text span size="xs" c="dimmed">
                                {" "}
                                ({l.quantity - (l.receivedQty ?? 0)} short)
                              </Text>
                            )}
                          </Table.Td>
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

      <Modal
        opened={receiveOpen}
        onClose={receive.close}
        title={`Receive against ${data?.poNumber ?? ""}`}
        size="lg"
      >
        <Text size="sm" c="dimmed" mb="md">
          Enter what actually arrived. Anything left short stays on the order and can be
          received later — the order stays open until nothing is outstanding.
        </Text>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th ta="right">Ordered</Table.Th>
              <Table.Th ta="right">Already in</Table.Th>
              <Table.Th ta="right">Outstanding</Table.Th>
              <Table.Th w={130}>Arriving now</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(data?.lines ?? []).map((line) => {
              const outstanding = outstandingOf(line);
              return (
                <Table.Tr key={line.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {line.product?.sku}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {line.product?.name} · {line.warehouse?.code}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">{line.quantity}</Table.Td>
                  <Table.Td ta="right">{line.receivedQty ?? 0}</Table.Td>
                  <Table.Td ta="right" fw={600}>
                    {outstanding}
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      value={counts[line.id] ?? 0}
                      onChange={(value) =>
                        setCounts((prev) => ({
                          ...prev,
                          [line.id]: value === "" ? "" : Number(value),
                        }))
                      }
                      min={0}
                      max={outstanding}
                      // Nothing left on this line, so there is nothing to type.
                      disabled={outstanding === 0}
                      clampBehavior="strict"
                      size="sm"
                    />
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>

        <Group justify="space-between" mt="lg">
          <div>
            <Text size="sm" fw={600}>
              {receivingTotal} unit{receivingTotal === 1 ? "" : "s"} arriving
            </Text>
            <Text size="xs" c="dimmed">
              Posting creates a goods receipt and its FIFO cost layers.
            </Text>
          </div>
          <Group gap="xs">
            <Button variant="default" onClick={receive.close}>
              Cancel
            </Button>
            <Button
              color="teal.9"
              loading={receiveMutation.isPending}
              disabled={receivingTotal <= 0}
              onClick={() => receiveMutation.mutate()}
            >
              Post receipt
            </Button>
          </Group>
        </Group>

        {data && receivingTotal > 0 && (
          <Progress
            mt="md"
            value={
              (((data.lines ?? []).reduce((s, l) => s + (l.receivedQty ?? 0), 0) + receivingTotal) /
                Math.max((data.lines ?? []).reduce((s, l) => s + l.quantity, 0), 1)) *
              100
            }
            color="teal"
            size="sm"
          />
        )}
      </Modal>
    </>
  );
}
