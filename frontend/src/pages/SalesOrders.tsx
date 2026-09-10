import {
  Anchor,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, qs, type Paginated, type Party, type SalesOrder } from "../api";
import { LineEditor, emptyLine, linesReady, type DraftLine } from "../components/LineEditor";
import {
  PageHeader,
  QueryState,
  StatusCell,
  formatDate,
  money,
  toastErr,
  toastOk,
} from "../components/ui";

const clickableRow = { cursor: "pointer" as const };

export default function SalesOrders() {
  const [search, setSearch] = useState("");
  const [readinessStatus, setReadiness] = useState<string | null>(null);
  const [paymentStatus, setPayment] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [opened, { open, close }] = useDisclosure(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [taxPercent, setTaxPercent] = useState<number | "">(8);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine]);
  const [debouncedSearch] = useDebouncedValue(search, 250);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const customers = useQuery({
    queryKey: ["customers", "options"],
    queryFn: () => api.get<Paginated<Party>>("/customers?activeOnly=true&pageSize=200"),
    staleTime: 60_000,
  });
  const employees = useQuery({
    queryKey: ["employees", "options"],
    queryFn: () => api.get<Paginated<Party>>("/employees?activeOnly=true&pageSize=200"),
    staleTime: 60_000,
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sales-orders", { search: debouncedSearch, readinessStatus, paymentStatus, page }],
    queryFn: () =>
      api.get<Paginated<SalesOrder>>(
        `/sales-orders${qs({ search: debouncedSearch, readinessStatus, paymentStatus, page, pageSize: 20 })}`
      ),
    placeholderData: keepPreviousData,
  });

  const create = useMutation({
    mutationFn: () => {
      const subtotal = lines.reduce(
        (s, l) => s + Number(l.unitAmountCents ?? 0) * Number(l.quantity),
        0
      );
      return api.post<SalesOrder>("/sales-orders", {
        customerId: Number(customerId),
        employeeId: employeeId ? Number(employeeId) : undefined,
        taxCents: Math.round((subtotal * Number(taxPercent || 0)) / 100),
        lines: lines.map((l) => ({
          productId: Number(l.productId),
          warehouseId: Number(l.warehouseId),
          quantity: Number(l.quantity),
          unitPriceCents: l.unitAmountCents ?? undefined,
        })),
      });
    },
    onSuccess: (order) => {
      toastOk(`${order.orderNumber} created`);
      setLines([emptyLine]);
      close();
      queryClient.invalidateQueries({ queryKey: ["sales-orders"] });
    },
    onError: toastErr,
  });

  const rows = data?.data ?? [];
  const canSubmit = customerId !== null && linesReady(lines);

  return (
    <>
      <PageHeader
        title="Sales orders"
        subtitle="Pack reserves stock; invoice and payment post to the ledger; shipping consumes FIFO cost."
        action={<Button onClick={open}>New sales order</Button>}
      />

      <Card withBorder radius="md" p={0}>
        <Group p="sm" align="flex-end" wrap="wrap" bg="var(--surface-sunken)">
          <TextInput
            label="Search"
            placeholder="Order number or customer"
            leftSection={<IconSearch size={15} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setPage(1);
            }}
            size="xs"
            w={240}
          />
          <Select
            label="Readiness"
            placeholder="Any"
            data={["NOT_PACKED", "PACKED", "SHIPPED", "CANCELED"]}
            value={readinessStatus}
            onChange={(v) => {
              setReadiness(v);
              setPage(1);
            }}
            clearable
            size="xs"
            w={160}
          />
          <Select
            label="Payment"
            placeholder="Any"
            data={["AWAITING_PAYMENT", "INVOICED", "PAID", "VOIDED"]}
            value={paymentStatus}
            onChange={(v) => {
              setPayment(v);
              setPage(1);
            }}
            clearable
            size="xs"
            w={180}
          />
        </Group>

        <QueryState
          isLoading={isLoading}
          error={error}
          isEmpty={rows.length === 0}
          emptyMessage={
            search || readinessStatus || paymentStatus
              ? "No sales orders match those filters."
              : "No sales orders yet."
          }
          emptyAction={
            !search && !readinessStatus && !paymentStatus && (
              <Button onClick={open}>New sales order</Button>
            )
          }
          onRetry={refetch}
        >
          <Table.ScrollContainer minWidth={900}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Order #</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th>Payment</Table.Th>
                  <Table.Th>Delivery</Table.Th>
                  <Table.Th>Channel</Table.Th>
                  <Table.Th>Manager</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((o) => (
                  <Table.Tr
                    key={o.id}
                    style={clickableRow}
                    onClick={() => navigate(`/sales-orders/${o.id}`)}
                  >
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(o.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Anchor component={Link} to={`/sales-orders/${o.id}`} size="sm" fw={600}>
                        {o.orderNumber}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{o.customerName}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {money(o.totalCents)}
                    </Table.Td>
                    <Table.Td p={0}>
                      <StatusCell value={o.paymentStatus} />
                    </Table.Td>
                    <Table.Td p={0}>
                      <StatusCell value={o.readinessStatus} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {o.channel}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {o.employee?.name ?? "—"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {data && data.totalPages > 1 && (
            <Group justify="flex-end" p="sm">
              <Pagination value={page} onChange={setPage} total={data.totalPages} size="sm" />
            </Group>
          )}
        </QueryState>
      </Card>

      <Modal opened={opened} onClose={close} title="New sales order" size="xl">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <Group grow mb="md">
            <Select
              label="Customer"
              placeholder="Pick a customer"
              required
              data={(customers.data?.data ?? []).map((c) => ({
                value: String(c.id),
                label: c.name,
              }))}
              value={customerId}
              onChange={setCustomerId}
              searchable
            />
            <Select
              label="Manager"
              placeholder="Unassigned"
              data={(employees.data?.data ?? []).map((e) => ({
                value: String(e.id),
                label: e.name,
              }))}
              value={employeeId}
              onChange={setEmployeeId}
              clearable
            />
            <NumberInput
              label="Tax %"
              min={0}
              max={100}
              value={taxPercent}
              onChange={(v) => setTaxPercent(v === "" ? "" : Number(v))}
            />
          </Group>

          <LineEditor
            lines={lines}
            onChange={setLines}
            defaultWarehouseId={null}
            amountLabel="Unit price"
          />

          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
              Create order
            </Button>
          </Group>
        </form>
      </Modal>
    </>
  );
}
