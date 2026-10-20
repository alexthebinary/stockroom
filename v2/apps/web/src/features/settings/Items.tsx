import { ActionIcon, Alert, Anchor, Autocomplete, Badge, Button, Card, FileButton, Group, Input, Modal, NumberInput, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconPencil } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { get, post, put } from "../../lib/api";
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
  const [adding, setAdding] = useState(false);
  const [debounced] = useDebouncedValue(search, 250);
  const facets = useQuery({ queryKey: ["item-facets"], queryFn: () => get<Facets>("/items/facets") });
  const query = new URLSearchParams();
  if (debounced) query.set("search", debounced);
  if (brand) query.set("brand", brand);
  if (category) query.set("category", category);
  const items = useQuery({ queryKey: ["items", debounced, brand, category], queryFn: () => get<Item[]>(`/items${query.size ? `?${query}` : ""}`), placeholderData: (prev) => prev });
  const valuation = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  const refreshItems = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["items"] }),
      queryClient.invalidateQueries({ queryKey: ["item-facets"] }),
    ]);
  };
  return (
    <>
      <PageHeader title="Items" action={
        <Group gap="xs">
          <Button onClick={() => setAdding(true)}>+ Add item</Button>
          <ItemCsvImport onImported={refreshItems} />
        </Group>
      } />
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
          const dimensions = [i.lengthCm, i.widthCm, i.heightCm];
          const measurements = [i.weightKg != null ? `${i.weightKg} kg` : null, dimensions.some((d) => d != null) ? `${dimensions.map((d) => d ?? "—").join("×")} cm` : null].filter(Boolean).join(" · ");
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
                  {measurements ? (
                    <Text size="sm" c="dimmed">{measurements}</Text>
                  ) : null}
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
      <Modal opened={adding || editing != null} onClose={() => { setEditing(null); setAdding(false); }} title={editing ? `Edit ${editing.sku}` : "Add item"}>
        {adding || editing ? (
          <EditItem
            key={editing?.id ?? "new"}
            item={editing}
            facets={facets.data}
            onSaved={async () => {
              setEditing(null);
              setAdding(false);
              toastOk(editing ? "Item saved" : "Item added");
              await refreshItems();
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

function EditItem({ item, facets, onSaved }: { item: Item | null; facets: Facets | undefined; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    sku: "",
    name: item?.name ?? "",
    weightKg: item?.weightKg ?? "",
    lengthCm: item?.lengthCm ?? "",
    widthCm: item?.widthCm ?? "",
    heightCm: item?.heightCm ?? "",
    brand: item?.brand ?? "",
    category: item?.category ?? "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name,
        weightKg: form.weightKg === "" ? null : Number(form.weightKg),
        lengthCm: form.lengthCm === "" ? null : Number(form.lengthCm),
        widthCm: form.widthCm === "" ? null : Number(form.widthCm),
        heightCm: form.heightCm === "" ? null : Number(form.heightCm),
        brand: form.brand,
        category: form.category,
      };
      if (item) await put(`/items/${item.id}`, body);
      else await post("/items", { ...body, sku: form.sku.trim() });
      await onSaved();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      {!item ? <TextInput label="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.currentTarget.value })} maxLength={64} required /> : null}
      <TextInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required />
      <NumberInput label="Weight (kg)" value={form.weightKg} onChange={(weightKg) => setForm({ ...form, weightKg })} min={0} allowNegative={false} step={0.1} />
      <Input.Wrapper label="Length × Width × Height (cm)">
        <Group grow gap="xs" wrap="nowrap">
          <NumberInput aria-label="Length (cm)" placeholder="Length" value={form.lengthCm} onChange={(lengthCm) => setForm({ ...form, lengthCm })} min={0} allowNegative={false} />
          <NumberInput aria-label="Width (cm)" placeholder="Width" value={form.widthCm} onChange={(widthCm) => setForm({ ...form, widthCm })} min={0} allowNegative={false} />
          <NumberInput aria-label="Height (cm)" placeholder="Height" value={form.heightCm} onChange={(heightCm) => setForm({ ...form, heightCm })} min={0} allowNegative={false} />
        </Group>
      </Input.Wrapper>
      <Autocomplete label="Brand" placeholder="e.g. XAG" data={facets?.brands ?? []} value={form.brand} onChange={(brand) => setForm({ ...form, brand })} maxLength={60} />
      <Autocomplete label="Category" placeholder="e.g. Chargers" data={facets?.categories ?? []} value={form.category} onChange={(category) => setForm({ ...form, category })} maxLength={60} />
      <Button onClick={save} loading={busy} disabled={!form.name.trim() || (!item && !form.sku.trim())}>
        Save
      </Button>
    </Stack>
  );
}

type ImportRow = { row: number; ok: boolean; error?: string; data?: { sku: string; name: string } };
type ImportResult = { commit: boolean; results: ImportRow[] };
const ITEM_CSV_COLUMNS = "sku,name,weight_kg,length_cm,width_cm,height_cm,brand,category,barcode,pack_qty,tracking,vendor,vendor_sku,cost";

function ItemCsvImport({ onImported }: { onImported: () => Promise<void> }) {
  const resetFile = useRef<() => void>(null);
  const [preview, setPreview] = useState<{ csv: string; filename: string; rows: ImportRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const result = await post<ImportResult>("/import/items", { csv, commit: false });
      setPreview({ csv, filename: file.name, rows: result.results });
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
      resetFile.current?.();
    }
  };
  const commit = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const result = await post<ImportResult>("/import/items", { csv: preview.csv, commit: true });
      if (result.commit) {
        toastOk(`Imported ${result.results.length} items`);
        setPreview(null);
        await onImported();
      } else {
        setPreview({ ...preview, rows: result.results });
      }
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const bad = preview?.rows.filter((row) => !row.ok).length ?? 0;
  const count = preview?.rows.filter((row) => row.ok).length ?? 0;

  return (
    <>
      <FileButton accept=".csv,text/csv" onChange={pick} resetRef={resetFile}>
        {(props) => <Button {...props} variant="light" loading={busy} disabled={busy}>Upload CSV</Button>}
      </FileButton>
      <Anchor size="sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(`${ITEM_CSV_COLUMNS}\r\n`)}`} download="items-template.csv">
        Download template
      </Anchor>
      <Modal opened={preview != null} onClose={() => { if (!busy) setPreview(null); }} title="Import items" size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}>
        {preview ? (
          <Stack>
            <Text size="sm" fw={600}>{preview.filename}</Text>
            <Text size="sm" c="dimmed">This import adds new items. Edit existing SKUs individually. Nothing is saved until you confirm.</Text>
            <Text size="sm">{count} items to add{bad ? ` · ${bad} rows need fixing` : ""}</Text>
            {bad > 0 ? <Alert color="orange">Fix the row errors in your CSV, then cancel and upload the corrected file.</Alert> : null}
            <Table.ScrollContainer minWidth={420} type="native" style={{ maxHeight: 360, overflow: "auto" }}>
              <Table>
                <Table.Thead>
                  <Table.Tr><Table.Th>Row</Table.Th><Table.Th>SKU</Table.Th><Table.Th>Name</Table.Th><Table.Th>Result</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.rows.map((row) => (
                    <Table.Tr key={row.row}>
                      <Table.Td>{row.row}</Table.Td>
                      <Table.Td>{row.data?.sku ?? "—"}</Table.Td>
                      <Table.Td>{row.data?.name ?? "—"}</Table.Td>
                      <Table.Td><Text size="sm" c={row.ok ? undefined : "orange"}>{row.ok ? "Add" : row.error}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setPreview(null)} disabled={busy}>Cancel</Button>
              <Button onClick={commit} loading={busy} disabled={bad > 0 || count === 0}>Import {count} items</Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </>
  );
}
