import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Modal,
  NumberInput,
  Pagination,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { IconSearch, IconTrash } from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, qs, type Paginated, type Product } from "../api";
import { PageHeader, QueryState, money, toastErr, toastOk } from "../components/ui";

type Draft = {
  sku: string;
  name: string;
  description: string;
  category: string;
  brand: string;
  barcode: string;
  weight: number | "";
  defaultCostCents: number;
  defaultPriceCents: number;
  length: number | "";
  width: number | "";
  height: number | "";
  isActive: boolean;
};

const emptyDraft: Draft = {
  sku: "",
  name: "",
  description: "",
  category: "",
  brand: "",
  barcode: "",
  weight: "",
  defaultCostCents: 0,
  defaultPriceCents: 0,
  length: "",
  width: "",
  height: "",
  isActive: true,
};

/** Empty strings are dropped so the API never receives "" where it expects a number. */
function toPayload(draft: Draft) {
  const num = (v: number | "") => (v === "" ? null : Number(v));
  return {
    sku: draft.sku.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    category: draft.category.trim() || null,
    brand: draft.brand.trim() || null,
    barcode: draft.barcode.trim() || null,
    weight: num(draft.weight),
    defaultCostCents: draft.defaultCostCents,
    defaultPriceCents: draft.defaultPriceCents,
    length: num(draft.length),
    width: num(draft.width),
    height: num(draft.height),
    isActive: draft.isActive,
  };
}


/** A hover highlight promises the row does something, so it has to. */
const clickableRow = { cursor: "pointer" as const };

export default function Products() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  // 250ms so the table is not torn down and refetched on every keystroke.
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [opened, { open, close }] = useDisclosure(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["products", { search: debouncedSearch, page }],
    queryFn: () => api.get<Paginated<Product>>(`/products${qs({ search: debouncedSearch, page, pageSize: 20 })}`),
    placeholderData: keepPreviousData,
  });

  const create = useMutation({
    mutationFn: () => api.post<Product>("/products", toPayload(draft)),
    onSuccess: () => {
      toastOk("Product created");
      setDraft(emptyDraft);
      close();
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: toastErr,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del<{ soft: boolean }>(`/products/${id}`),
    onSuccess: (res) => {
      toastOk(res.soft ? "Product deactivated (it has history)" : "Product deleted");
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: toastErr,
  });

  /**
   * Deleting a product with no history is irreversible, so it always asks
   * first and says which of the two outcomes will happen.
   */
  function confirmDelete(product: Product) {
    const hasStock = (product.totalOnHand ?? 0) > 0 || (product.totalIncoming ?? 0) > 0;
    modals.openConfirmModal({
      title: `Delete ${product.sku}?`,
      centered: true,
      children: (
        <Text size="sm">
          {hasStock
            ? `${product.name} still has stock recorded against it. It will be deactivated rather than removed, so its history stays intact.`
            : `${product.name} will be permanently removed if it has no movements, orders, transfers or adjustments. Otherwise it is deactivated. This cannot be undone.`}
        </Text>
      ),
      labels: { confirm: "Delete product", cancel: "Keep it" },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(product.id),
    });
  }

  const rows = data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Every SKU in the catalogue, with stock summed across warehouses."
        action={<Button onClick={open}>New product</Button>}
      />

      <Card withBorder radius="md" p="md">
        <TextInput
          label="Search"
          placeholder="SKU, name or barcode"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
          mb="md"
          maw={420}
        />

        <QueryState
          isLoading={isLoading}
          error={error}
          isEmpty={rows.length === 0}
          emptyMessage={search ? `No products match "${search}".` : "No products yet."}
          emptyAction={!search && <Button onClick={open}>New product</Button>}
          onRetry={refetch}
        >
          <Table.ScrollContainer minWidth={760}>
            <Table className="data-grid" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>SKU</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Category</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Cost</Table.Th>
                  <Table.Th ta="right">Price</Table.Th>
                  <Table.Th ta="right">On hand</Table.Th>
                  <Table.Th ta="right">Available</Table.Th>
                  <Table.Th ta="right">Incoming</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((p) => (
                  <Table.Tr key={p.id} style={clickableRow} onClick={() => navigate(`/products/${p.id}`)}>
                    <Table.Td>
                      <Anchor component={Link} to={`/products/${p.id}`}>{p.sku}</Anchor>
                    </Table.Td>
                    <Table.Td>{p.name}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {p.category ?? "—"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={p.isActive ? "teal" : "gray"} variant="light" radius="sm">
                        {p.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right">{money(p.defaultCostCents)}</Table.Td>
                    <Table.Td ta="right">{money(p.defaultPriceCents)}</Table.Td>
                    <Table.Td ta="right">{p.totalOnHand ?? 0}</Table.Td>
                    <Table.Td ta="right">{p.totalAvailable ?? 0}</Table.Td>
                    <Table.Td ta="right">{p.totalIncoming ?? 0}</Table.Td>
                    <Table.Td onClick={(event) => event.stopPropagation()}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Delete ${p.sku}`}
                        loading={remove.isPending && remove.variables === p.id}
                        onClick={() => confirmDelete(p)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
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

      <Modal opened={opened} onClose={close} title="New product" size="lg">
        {/* A form element, so Enter creates the record without reaching for
            the pointer — this app is used for repetitive data entry. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.sku.trim() && draft.name.trim()) create.mutate();
          }}
        >
        <Grid>
          <Grid.Col span={6}>
            <TextInput
              label="SKU"
              required
              value={draft.sku}
              onChange={(e) => setDraft({ ...draft, sku: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput
              label="Name"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput
              label="Category"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput
              label="Brand"
              value={draft.brand}
              onChange={(e) => setDraft({ ...draft, brand: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput
              label="Barcode"
              value={draft.barcode}
              onChange={(e) => setDraft({ ...draft, barcode: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              label="Default cost"
              prefix="$"
              min={0}
              decimalScale={2}
              fixedDecimalScale
              value={draft.defaultCostCents / 100}
              onChange={(v) =>
                setDraft({ ...draft, defaultCostCents: Math.round(Number(v || 0) * 100) })
              }
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              label="Default price"
              prefix="$"
              min={0}
              decimalScale={2}
              fixedDecimalScale
              value={draft.defaultPriceCents / 100}
              onChange={(v) =>
                setDraft({ ...draft, defaultPriceCents: Math.round(Number(v || 0) * 100) })
              }
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              label="Weight (kg)"
              value={draft.weight}
              min={0}
              decimalScale={3}
              onChange={(v) => setDraft({ ...draft, weight: v === "" ? "" : Number(v) })}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <NumberInput
              label="Length (cm)"
              value={draft.length}
              min={0}
              onChange={(v) => setDraft({ ...draft, length: v === "" ? "" : Number(v) })}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <NumberInput
              label="Width (cm)"
              value={draft.width}
              min={0}
              onChange={(v) => setDraft({ ...draft, width: v === "" ? "" : Number(v) })}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <NumberInput
              label="Height (cm)"
              value={draft.height}
              min={0}
              onChange={(v) => setDraft({ ...draft, height: v === "" ? "" : Number(v) })}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Textarea
              label="Description"
              autosize
              minRows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Switch
              label="Active"
              checked={draft.isActive}
              onChange={(e) => setDraft({ ...draft, isActive: e.currentTarget.checked })}
            />
          </Grid.Col>
        </Grid>

        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={!draft.sku.trim() || !draft.name.trim()}
          >
            Create product
          </Button>
        </Group>
        </form>
      </Modal>
    </>
  );
}
