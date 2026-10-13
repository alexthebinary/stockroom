import { ActionIcon, Autocomplete, Badge, Button, Card, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconPencil } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { get, put } from "../../lib/api";
import type { Item } from "../../lib/types";

type Valuation = { rows: { itemId: number; onHand: number; held: number; valueCents: number; averageCents: number }[] };
type Facets = { brands: string[]; categories: string[] };

/** Find an item: what's on the shelf, what's waiting for a bill, and its codes. Filter by brand and category. */
export function Items() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [debounced] = useDebouncedValue(search, 250);
  const facets = useQuery({ queryKey: ["item-facets"], queryFn: () => get<Facets>("/items/facets") });
  const query = new URLSearchParams();
  if (debounced) query.set("search", debounced);
  if (brand) query.set("brand", brand);
  if (category) query.set("category", category);
  const items = useQuery({ queryKey: ["items", debounced, brand, category], queryFn: () => get<Item[]>(`/items${query.size ? `?${query}` : ""}`), placeholderData: (prev) => prev });
  const valuation = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  return (
    <>
      <PageHeader title="Items" />
      <Stack gap="xs" mb="md">
        <TextInput placeholder="Search name, SKU, brand or barcode" value={search} onChange={(e) => setSearch(e.currentTarget.value)} size="md" />
        <Group grow gap="xs">
          <Select aria-label="Brand" placeholder="All brands" data={facets.data?.brands ?? []} value={brand} onChange={setBrand} clearable searchable />
          <Select aria-label="Category" placeholder="All categories" data={facets.data?.categories ?? []} value={category} onChange={setCategory} clearable searchable />
        </Group>
      </Stack>
      <Stack gap="xs">
        {(items.data ?? []).map((i) => {
          const v = valuation.data?.rows.find((r) => r.itemId === i.id);
          return (
            <Card key={i.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {i.name}
                  </Text>
                  <Text size="sm" c="dimmed" truncate>
                    {i.sku}
                    {i.barcodes?.length ? ` · ${i.barcodes.map((b) => b.raw).join(", ")}` : ""}
                  </Text>
                  {i.brand || i.category ? (
                    <Group gap={6} mt={4}>
                      {i.brand ? (
                        <Badge variant="light" color="lime" onClick={() => setBrand(i.brand!)} style={{ cursor: "pointer" }}>
                          {i.brand}
                        </Badge>
                      ) : null}
                      {i.category ? (
                        <Badge variant="outline" color="gray" onClick={() => setCategory(i.category!)} style={{ cursor: "pointer" }}>
                          {i.category}
                        </Badge>
                      ) : null}
                    </Group>
                  ) : null}
                </div>
                <Group gap="xs" wrap="nowrap">
                  {i.trackingMode === "SERIAL" ? <Badge>Serial</Badge> : null}
                  {i.condition !== "NEW" ? <Badge color="gray">{i.condition.replace("_", " ").toLowerCase()}</Badge> : null}
                  <Stack gap={0} align="flex-end">
                    <Text fw={700}>{v?.onHand ?? 0} on hand</Text>
                    {v?.held ? (
                      <Text size="xs" c="orange">
                        {v.held} awaiting bill
                      </Text>
                    ) : null}
                  </Stack>
                  <ActionIcon variant="subtle" color="gray" aria-label={`Edit ${i.name}`} onClick={() => setEditing(i)}>
                    <IconPencil size={18} />
                  </ActionIcon>
                </Group>
              </Group>
            </Card>
          );
        })}
        {items.data && items.data.length === 0 ? <div className="ruled-empty">No items match{brand || category || debounced ? " these filters" : " yet"}.</div> : null}
      </Stack>
      <Modal opened={editing != null} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.sku}` : ""}>
        {editing ? (
          <EditItem
            key={editing.id}
            item={editing}
            facets={facets.data}
            onSaved={async () => {
              setEditing(null);
              toastOk("Item saved");
              await queryClient.invalidateQueries({ queryKey: ["items"] });
              await queryClient.invalidateQueries({ queryKey: ["item-facets"] });
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

function EditItem({ item, facets, onSaved }: { item: Item; facets: Facets | undefined; onSaved: () => void }) {
  const [form, setForm] = useState({ name: item.name, brand: item.brand ?? "", category: item.category ?? "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/items/${item.id}`, { name: form.name, brand: form.brand, category: form.category });
      onSaved();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required />
      <Autocomplete label="Brand" placeholder="e.g. XAG" data={facets?.brands ?? []} value={form.brand} onChange={(brand) => setForm({ ...form, brand })} maxLength={60} />
      <Autocomplete label="Category" placeholder="e.g. Chargers" data={facets?.categories ?? []} value={form.category} onChange={(category) => setForm({ ...form, category })} maxLength={60} />
      <Button onClick={save} loading={busy} disabled={!form.name.trim()}>
        Save
      </Button>
    </Stack>
  );
}
