import {
  Anchor,
  Card,
  Group,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, qs, type Balance, type Paginated } from "../api";
import { SortableTh } from "../components/SortableTh";
import { PageHeader, QueryState, money } from "../components/ui";
import { useProductOptions, useWarehouseOptions } from "../hooks";


/** A hover highlight promises the row does something, so it has to. */
const clickableRow = { cursor: "pointer" as const };

export default function Inventory() {
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  // 250ms so the table is not torn down and refetched on every keystroke.
  const [debouncedSearch] = useDebouncedValue(search, 250);

  const navigate = useNavigate();
  const warehouses = useWarehouseOptions();
  const products = useProductOptions();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["inventory", { search: debouncedSearch, warehouseId, productId, page, sort, dir }],
    queryFn: () =>
      api.get<Paginated<Balance>>(
        `/inventory${qs({ search: debouncedSearch, warehouseId, productId, page, pageSize: 25, sort, dir })}`
      ),
    placeholderData: keepPreviousData,
  });

  const rows = data?.data ?? [];
  const resetPage = () => setPage(1);

  /** Click a heading to sort by it; click the sorted heading to reverse it. */
  function toggleSort(column: string) {
    if (sort === column) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(column);
      setDir("asc");
    }
    resetPage();
  }
  const sortProps = { sort, dir, onSort: toggleSort };

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Every product and warehouse pair. Available is on hand minus what is reserved for packed orders."
      />

      <Card withBorder radius="md" p="md">
        <Group mb="md" align="flex-end" wrap="wrap">
          <TextInput
            label="Search"
            placeholder="SKU or name"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              resetPage();
            }}
            w={260}
          />
          <Select
            label="Warehouse"
            placeholder="All warehouses"
            data={warehouses.options}
            value={warehouseId}
            onChange={(v) => {
              setWarehouseId(v);
              resetPage();
            }}
            clearable
            w={230}
          />
          <Select
            label="Product"
            placeholder="All products"
            data={products.options}
            value={productId}
            onChange={(v) => {
              setProductId(v);
              resetPage();
            }}
            clearable
            searchable
            w={300}
          />
        </Group>

        <QueryState
          isLoading={isLoading}
          error={error}
          isEmpty={rows.length === 0}
          emptyMessage={
            search || warehouseId || productId
              ? "No inventory rows match those filters."
              : "No stock recorded yet. Receive a purchase order or make an adjustment to get started."
          }
          onRetry={refetch}
        >
          <Table.ScrollContainer minWidth={760}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <SortableTh column="sku" {...sortProps}>SKU</SortableTh>
                  <SortableTh column="name" {...sortProps}>Product</SortableTh>
                  <SortableTh column="warehouse" {...sortProps}>Warehouse</SortableTh>
                  <SortableTh column="onHandQty" align="right" {...sortProps}>On hand</SortableTh>
                  <SortableTh column="reservedQty" align="right" {...sortProps}>Reserved</SortableTh>
                  <SortableTh column="incomingQty" align="right" {...sortProps}>Incoming</SortableTh>
                  {/* Available is derived (on hand - reserved), so there is no
                      column to sort on without loading the whole table. */}
                  <SortableTh column="reorderPoint" align="right" {...sortProps}>
                    Reorder at
                  </SortableTh>
                  <Table.Th ta="right">Available</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((b) => (
                  <Table.Tr key={b.id} style={clickableRow} onClick={() => navigate(`/products/${b.productId}`)}>
                    <Table.Td>
                      <Anchor component={Link} to={`/products/${b.productId}`}>{b.product?.sku}</Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{b.product?.name}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/warehouses/${b.warehouseId}`}>{b.warehouse?.code}</Anchor>
                    </Table.Td>
                    <Table.Td ta="right">{b.onHandQty}</Table.Td>
                    <Table.Td ta="right">{b.reservedQty}</Table.Td>
                    <Table.Td ta="right">{b.incomingQty}</Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c={b.onHandQty < b.reorderPoint ? "orange" : "dimmed"}>
                        {b.reorderPoint || "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" fw={600}>
                      {b.availableQty}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {data && data.totalPages > 1 && (
            <Group justify="flex-end" mt="md">
              <Pagination value={page} onChange={setPage} total={data.totalPages} size="sm" />
            </Group>
          )}
        </QueryState>
      </Card>
    </>
  );
}
