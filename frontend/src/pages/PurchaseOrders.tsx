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
import { api, qs, type Paginated, type Party, type PurchaseOrder } from "../api";
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

export default function PurchaseOrders() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [opened, { open, close }] = useDisclosure(false);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [taxPercent, setTaxPercent] = useState<number | "">(8);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine]);
  const [debouncedSearch] = useDebouncedValue(search, 250);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const vendors = useQuery({
    queryKey: ["vendors", "options"],
    queryFn: () => api.get<Paginated<Party>>("/vendors?activeOnly=true&pageSize=200"),
    staleTime: 60_000,
  });
  const employees = useQuery({
    queryKey: ["employees", "options"],
    queryFn: () => api.get<Paginated<Party>>("/employees?activeOnly=true&pageSize=200"),
    staleTime: 60_000,
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["purchase-orders", { search: debouncedSearch, status, page }],
    queryFn: () =>
      api.get<Paginated<PurchaseOrder>>(
        `/purchase-orders${qs({ search: debouncedSearch, status, page, pageSize: 20 })}`
      ),
    placeholderData: keepPreviousData,
  });

  const create = useMutation({
    mutationFn: () => {
      const subtotal = lines.reduce(
        (s, l) => s + Number(l.unitAmountCents ?? 0) * Number(l.quantity),
        0
      );
      return api.post<PurchaseOrder>("/purchase-orders", {
        vendorId: Number(vendorId),
        employeeId: employeeId ? Number(employeeId) : undefined,
        taxCents: Math.round((subtotal * Number(taxPercent || 0)) / 100),
        lines: lines.map((l) => ({
          productId: Number(l.productId),
          warehouseId: Number(l.warehouseId),
          quantity: Number(l.quantity),
          unitCostCents: l.unitAmountCents ?? undefined,
        })),
      });
    },
    onSuccess: (order) => {
      toastOk(`${order.poNumber} created`);
      setLines([emptyLine]);
      close();
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
    onError: toastErr,
  });

  const rows = data?.data ?? [];
  const canSubmit = vendorId !== null && linesReady(lines);

  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="Saved books incoming stock. Posted creates the bill, paid settles it, delivered creates the GRN and the FIFO cost layers."
        action={<Button onClick={open}>New purchase order</Button>}
      />

      <Card withBorder radius="md" p={0}>
        <Group p="sm" align="flex-end" wrap="wrap" bg="var(--surface-sunken)">
          <TextInput
            label="Search"
            placeholder="PO number or supplier"
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
            label="Status"
            placeholder="Any"
            data={["SAVED", "POSTED", "PAID", "DELIVERED", "CANCELED"]}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            clearable
            size="xs"
            w={170}
          />
        </Group>

        <QueryState
          isLoading={isLoading}
          error={error}
          isEmpty={rows.length === 0}
          emptyMessage={
            search || status
              ? "No purchase orders match those filters."
              : "No purchase orders yet."
          }
          emptyAction={
            !search && !status && <Button onClick={open}>New purchase order</Button>
          }
          onRetry={refetch}
        >
          <Table.ScrollContainer minWidth={900}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>PO #</Table.Th>
                  <Table.Th>Vendor</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Manager</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((o) => (
                  <Table.Tr
                    key={o.id}
                    style={clickableRow}
                    onClick={() => navigate(`/purchase-orders/${o.id}`)}
                  >
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(o.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Anchor component={Link} to={`/purchase-orders/${o.id}`} size="sm" fw={600}>
                        {o.poNumber}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{o.supplierName}</Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {money(o.totalCents)}
                    </Table.Td>
                    <Table.Td p={0}>
                      <StatusCell value={o.status} />
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

      <Modal opened={opened} onClose={close} title="New purchase order" size="xl">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <Group grow mb="md">
            <Select
              label="Vendor"
              placeholder="Pick a vendor"
              required
              data={(vendors.data?.data ?? []).map((c) => ({
                value: String(c.id),
                label: c.name,
              }))}
              value={vendorId}
              onChange={setVendorId}
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
            amountLabel="Unit cost"
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
