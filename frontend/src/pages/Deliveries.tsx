import {
  Anchor,
  Badge,
  Card,
  Group,
  Pagination,
  SegmentedControl,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type DeliveryRow, type Paginated, openPdf } from "../api";
import { PageHeader, QueryState, Stat, formatDate, toastErr } from "../components/ui";

type Delivered = "" | "NO" | "YES";

/**
 * Shipments across every order.
 *
 * "In transit" here means nobody has told us it arrived. Stockroom does not
 * poll a carrier and must not imply that it can, so the filter is a three-way
 * choice and not a boolean: All, In transit, Delivered.
 */
export default function Deliveries() {
  const [delivered, setDelivered] = useState<Delivered>("");
  const [carrier, setCarrier] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const carriers = useQuery({
    queryKey: ["shipping-carriers"],
    queryFn: () => api.get<{ carriers: string[] }>("/sales-orders/shipping-carriers"),
    staleTime: Infinity,
  });

  const list = useQuery({
    queryKey: ["deliveries", { delivered, carrier, search, page }],
    queryFn: () =>
      api.get<Paginated<DeliveryRow>>(
        `/sales-orders/shipments${qs({ delivered, carrier, search, page, pageSize: 25 })}`
      ),
  });

  const rows = list.data?.data ?? [];
  const inTransit = rows.filter((s) => !s.deliveredAt).length;

  return (
    <>
      <PageHeader
        title="Deliveries"
        subtitle="Every shipment that has left a warehouse. Delivery is asserted by a person — ProfitIndex records carriers and numbers, it does not call them."
      />

      <Group grow mb="lg" align="stretch">
        <Stat label="Shipments on this page" value={rows.length} />
        <Stat
          label="In transit"
          value={inTransit}
          hint={
            // Zero in transit out of zero shipments is not "all delivered" —
            // that reads as a reassuring all-clear for a question nobody asked.
            rows.length === 0
              ? "Nothing shipped yet"
              : inTransit > 0
                ? "Nobody has confirmed arrival"
                : "All confirmed delivered"
          }
        />
      </Group>

      <Card withBorder radius="md" p="md" mb="lg">
        <Group align="flex-end" wrap="wrap" gap="sm">
          <SegmentedControl
            value={delivered}
            onChange={(value) => {
              setDelivered(value as Delivered);
              setPage(1);
            }}
            data={[
              { label: "All", value: "" },
              { label: "In transit", value: "NO" },
              { label: "Delivered", value: "YES" },
            ]}
          />
          <Select
            label="Carrier"
            placeholder="Any"
            clearable
            w={180}
            value={carrier}
            onChange={(value) => {
              setCarrier(value);
              setPage(1);
            }}
            data={carriers.data?.carriers ?? []}
          />
          <TextInput
            label="Search"
            placeholder="Shipment, tracking, order or customer"
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            w={280}
          />
        </Group>
      </Card>

      <Card withBorder radius="md" p={0}>
        <QueryState
          isLoading={list.isLoading}
          error={list.error}
          isEmpty={rows.length === 0}
          emptyMessage="No shipments match these filters."
          onRetry={list.refetch}
        >
          <Table.ScrollContainer minWidth={900}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Shipment</Table.Th>
                  <Table.Th>Shipped</Table.Th>
                  <Table.Th>Order</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th>From</Table.Th>
                  <Table.Th>Carrier</Table.Th>
                  <Table.Th>Tracking</Table.Th>
                  <Table.Th>Delivery</Table.Th>
                  <Table.Th>Documents</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((shipment) => (
                  <Table.Tr key={shipment.id}>
                    <Table.Td fw={600}>{shipment.shipmentNumber}</Table.Td>
                    <Table.Td>{formatDate(shipment.shippedAt)}</Table.Td>
                    <Table.Td>
                      {shipment.salesOrder ? (
                        <Anchor component={Link} to={`/sales-orders/${shipment.salesOrder.id}`}>
                          {shipment.salesOrder.orderNumber}
                        </Anchor>
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>{shipment.salesOrder?.customerName ?? "—"}</Table.Td>
                    <Table.Td>
                      {/* Null when the order shipped from more than one
                          warehouse — the lines are the authority, not this. */}
                      {shipment.warehouse ? shipment.warehouse.code : "Multiple"}
                    </Table.Td>
                    <Table.Td>{shipment.carrier ?? <Text span c="dimmed">—</Text>}</Table.Td>
                    <Table.Td>
                      {shipment.trackingNumber ? (
                        shipment.trackingUrl ? (
                          <Anchor
                            href={shipment.trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            size="sm"
                          >
                            <Group gap={4} wrap="nowrap">
                              {shipment.trackingNumber}
                              <IconExternalLink size={13} />
                            </Group>
                          </Anchor>
                        ) : (
                          // A carrier we have no tracking URL for. The number is
                          // still the number the customer quotes.
                          <Text span size="sm">
                            {shipment.trackingNumber}
                          </Text>
                        )
                      ) : (
                        <Text span c="dimmed">
                          Not recorded
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {shipment.deliveredAt ? (
                        <Badge variant="light" color="teal">
                          {formatDate(shipment.deliveredAt)}
                        </Badge>
                      ) : (
                        <Badge variant="light" color="blue">
                          In transit
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Anchor
                          component="button"
                          type="button"
                          onClick={() => openPdf(`/sales-orders/shipments/${shipment.id}/packing-slip.pdf`).catch(toastErr)}
                          size="sm"
                        >
                          Slip
                        </Anchor>
                        <Anchor
                          component="button"
                          type="button"
                          onClick={() => openPdf(`/sales-orders/shipments/${shipment.id}/label.pdf`).catch(toastErr)}
                          size="sm"
                        >
                          Label
                        </Anchor>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </QueryState>
      </Card>

      {(list.data?.totalPages ?? 1) > 1 && (
        <Group justify="flex-end" mt="md">
          <Pagination value={page} onChange={setPage} total={list.data?.totalPages ?? 1} />
        </Group>
      )}
    </>
  );
}
