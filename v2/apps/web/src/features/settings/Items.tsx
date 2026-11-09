import { ActionIcon, Alert, Anchor, Autocomplete, Badge, Button, Card, FileButton, Group, Input, Modal, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { get, patch, post, put } from "../../lib/api";
import type { Item, Warehouse } from "../../lib/types";
import { cmToIn, formatMeasurements, inToCm, kgToLb, lbToKg } from "../../lib/units";

type Valuation = { rows: { itemId: number; onHand: number; held: number; valueCents: number; averageCents: number }[] };
type ReceiptRow = { id: number; number: string; state: string; receivedAt: string; receivedBy: string; po: { number: string }; lines: { qty: number }[] };
type OtherTx = { number: string; type: string; date: string; qty: number; lines: number; actor: string };
type Facets = { brands: string[]; categories: string[] };

/** Find an item: what's on the shelf, what's waiting for a bill, and its codes. Filter by brand and category. */
export function Items() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [adding, setAdding] = useState(false);
  const [bundleForm, setBundleForm] = useState<Item | "new" | null>(null);
  const [shipping, setShipping] = useState<Item | null>(null);
  const [debounced] = useDebouncedValue(search, 250);
  const facets = useQuery({ queryKey: ["item-facets"], queryFn: () => get<Facets>("/items/facets") });
  const query = new URLSearchParams();
  if (debounced) query.set("search", debounced);
  if (brand) query.set("brand", brand);
  if (category) query.set("category", category);
  const items = useQuery({ queryKey: ["items", debounced, brand, category], queryFn: () => get<Item[]>(`/items${query.size ? `?${query}` : ""}`), placeholderData: (prev) => prev });
  const valuation = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  const receipts = useQuery({ queryKey: ["receipts"], queryFn: () => get<ReceiptRow[]>("/receipts") });
  const otherTx = useQuery({ queryKey: ["other-transactions"], queryFn: () => get<OtherTx[]>("/other-transactions") });
  const refreshItems = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["items"] }),
      queryClient.invalidateQueries({ queryKey: ["item-facets"] }),
    ]);
  };
  return (
    <>
      <title>Inventory · ProfitIndex</title>
      <PageHeader title="Inventory" action={
        <Group gap="xs">
          <Button onClick={() => setAdding(true)}>+ Add item</Button>
          <Button variant="light" onClick={() => setBundleForm("new")}>Create bundle</Button>
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
          const measurements = formatMeasurements(i);
          return (
            <Card key={i.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {i.name}
                  </Text>
                  <Text size="sm" c="dimmed" truncate>
                    {i.sku}
                    {i.isBundle ? ` · ${i.components?.map((c) => `${c.qty}× ${c.name}`).join(" + ")}` : ""}
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
                  {i.isBundle ? <Badge color="grape">Bundle</Badge> : null}
                  {i.trackingMode === "SERIAL" ? <Badge>Serial</Badge> : null}
                  {i.condition !== "NEW" ? <Badge color="gray">{i.condition.replace("_", " ").toLowerCase()}</Badge> : null}
                  {i.isBundle ? (
                    <>
                      <Stack gap={0} align="flex-end">
                        <Text fw={700}>{i.available ?? 0} available</Text>
                        {i.priceCents != null ? <Text size="xs" c="dimmed">${(i.priceCents / 100).toFixed(2)}</Text> : null}
                      </Stack>
                      <Button size="xs" variant="light" onClick={() => setShipping(i)} aria-label={`Ship ${i.name}`}>Ship</Button>
                      <Button size="xs" variant="default" onClick={() => setBundleForm(i)} aria-label={`Edit ${i.name}`}>Edit</Button>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </Group>
              </Group>
            </Card>
          );
        })}
        {items.data && items.data.length === 0 ? <div className="ruled-empty">No items match{brand || category || debounced ? " these filters" : " yet"}.</div> : null}
      </Stack>
      <section aria-labelledby="warehouse-receipts-heading">
        <Title order={2} size="h3" mt="xl" mb="xs" id="warehouse-receipts-heading">Warehouse Receipts</Title>
        <Stack gap="xs">
          {(receipts.data ?? []).map((r) => (
            <Card key={r.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{r.number}</Text>
                  <Text size="sm" c="dimmed" truncate>{r.po.number} · {new Date(r.receivedAt).toLocaleDateString()} · {r.receivedBy}</Text>
                </div>
                <Group gap="xs" wrap="nowrap">
                  <Text fw={700}>{r.lines.reduce((n, l) => n + l.qty, 0)} units</Text>
                  <Badge variant="light" color="gray">{r.state.replace(/_/g, " ").toLowerCase()}</Badge>
                </Group>
              </Group>
            </Card>
          ))}
          {receipts.data && receipts.data.length === 0 ? <div className="ruled-empty">No warehouse receipts yet.</div> : null}
        </Stack>
      </section>
      <section aria-labelledby="other-transactions-heading">
        <Title order={2} size="h3" mt="xl" mb="xs" id="other-transactions-heading">Other Inventory Transactions</Title>
        <Stack gap="xs">
          {(otherTx.data ?? []).map((t) => (
            <Card key={t.number} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{t.number}</Text>
                  <Text size="sm" c="dimmed" truncate>{t.type} · {new Date(t.date).toLocaleDateString()} · {t.actor}</Text>
                </div>
                <Text fw={700}>{t.qty > 0 ? "+" : ""}{t.qty} units</Text>
              </Group>
            </Card>
          ))}
          {otherTx.data && otherTx.data.length === 0 ? <div className="ruled-empty">No other inventory transactions yet.</div> : null}
        </Stack>
      </section>
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
      <Modal opened={bundleForm != null} onClose={() => setBundleForm(null)} title={bundleForm && bundleForm !== "new" ? `Edit ${bundleForm.sku}` : "Create bundle"} size="lg">
        {bundleForm ? (
          <BundleForm
            key={bundleForm === "new" ? "new" : bundleForm.id}
            bundle={bundleForm === "new" ? null : bundleForm}
            onSaved={async () => {
              const wasEdit = bundleForm !== "new";
              setBundleForm(null);
              toastOk(wasEdit ? "Bundle saved" : "Bundle created");
              await refreshItems();
            }}
          />
        ) : null}
      </Modal>
      <Modal opened={shipping != null} onClose={() => setShipping(null)} title={shipping ? `Ship ${shipping.name}` : "Ship bundle"}>
        {shipping ? (
          <ShipBundle
            key={shipping.id}
            bundle={shipping}
            onShipped={async (docNumber) => {
              setShipping(null);
              toastOk(`Shipped (${docNumber})`);
              await Promise.all([refreshItems(), queryClient.invalidateQueries({ queryKey: ["valuation"] })]);
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

type Row = { itemId: string; qty: number | string };

/** Create or edit a bundle: one fixed recipe of plain items. */
function BundleForm({ bundle, onSaved }: { bundle: Item | null; onSaved: () => Promise<void> }) {
  const all = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const [name, setName] = useState(bundle?.name ?? "");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState<number | string>(bundle?.priceCents != null ? bundle.priceCents / 100 : "");
  const [rows, setRows] = useState<Row[]>(bundle?.components?.length ? bundle.components.map((c) => ({ itemId: String(c.id), qty: c.qty })) : [{ itemId: "", qty: 1 }]);
  const [busy, setBusy] = useState(false);
  const valuation = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  const choices = (all.data ?? []).filter((i) => !i.isBundle && i.trackingMode !== "SERIAL");
  const byId = (id: string) => choices.find((i) => String(i.id) === id);
  const onHand = (id: string) => valuation.data?.rows.filter((r) => String(r.itemId) === id).reduce((s, r) => s + r.onHand, 0) ?? 0;
  const filled = rows.filter((r) => r.itemId && Number(r.qty) > 0);
  const canMake = filled.length ? Math.min(...filled.map((r) => Math.floor(onHand(r.itemId) / Number(r.qty)))) : 0;
  const hint = filled.reduce((s, r) => s + (byId(r.itemId)?.lastCostCents ?? 0) * Number(r.qty), 0);
  const setRow = (index: number, change: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const components = filled.map((r) => ({ itemId: Number(r.itemId), qty: Number(r.qty) }));
      const priceCents = price === "" ? null : Math.round(Number(price) * 100);
      if (bundle) await patch(`/bundles/${bundle.id}`, { name, priceCents, components });
      else await post("/bundles", { sku: sku.trim(), name, priceCents, components });
      await onSaved();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      {!bundle ? <TextInput label="SKU" value={sku} onChange={(e) => setSku(e.currentTarget.value)} maxLength={64} required /> : null}
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      <NumberInput label="Price ($, optional)" value={price} onChange={setPrice} min={0} decimalScale={2} allowNegative={false} description={hint > 0 ? `Components last cost add up to $${(hint / 100).toFixed(2)} (a hint only)` : undefined} />
      <Input.Wrapper label="Recipe">
        <Stack gap="xs">
          {rows.map((row, index) => (
            <Group key={index} gap="xs" wrap="nowrap" align="flex-end">
              <Select
                aria-label={`Component ${index + 1}`}
                placeholder="Search an item"
                searchable
                style={{ flex: 1 }}
                data={choices.map((i) => ({ value: String(i.id), label: `${i.name} · ${i.sku}`, disabled: rows.some((r, j) => j !== index && r.itemId === String(i.id)) }))}
                value={row.itemId || null}
                onChange={(value) => setRow(index, { itemId: value ?? "" })}
              />
              <NumberInput aria-label={`Quantity ${index + 1}`} w={80} min={1} allowDecimal={false} allowNegative={false} value={row.qty} onChange={(qty) => setRow(index, { qty })} />
              <ActionIcon variant="subtle" color="gray" aria-label={`Remove component ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button size="xs" variant="subtle" onClick={() => setRows([...rows, { itemId: "", qty: 1 }])}>+ Add component</Button>
          </Group>
        </Stack>
      </Input.Wrapper>
      <Text size="sm" fw={600}>Can make {canMake}</Text>
      <Button onClick={save} loading={busy} disabled={!name.trim() || (!bundle && !sku.trim()) || filled.length === 0}>Save</Button>
    </Stack>
  );
}

function ShipBundle({ bundle, onShipped }: { bundle: Item; onShipped: (docNumber: string) => Promise<void> }) {
  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => get<Warehouse[]>("/warehouses") });
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>(1);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const wid = warehouseId ?? (warehouses.data?.length === 1 ? String(warehouses.data[0]!.id) : null);
  const available = wid ? (bundle.availableByWarehouse?.[wid] ?? 0) : null;
  const ship = async () => {
    if (!wid || busy) return;
    setBusy(true);
    try {
      const result = await post<{ docNumber: string }>(`/bundles/${bundle.id}/ship`, { warehouseId: Number(wid), qty: Number(qty), reference: reference.trim() });
      await onShipped(result.docNumber);
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Select label="Warehouse" data={(warehouses.data ?? []).map((w) => ({ value: String(w.id), label: `${w.name} (${w.code})` }))} value={wid} onChange={setWarehouseId} />
      <NumberInput label="How many" value={qty} onChange={setQty} min={1} allowDecimal={false} allowNegative={false} description={available != null ? `Can make ${available} here` : undefined} />
      <TextInput label="Reference" placeholder="e.g. order number" value={reference} onChange={(e) => setReference(e.currentTarget.value)} maxLength={300} />
      <Button onClick={ship} loading={busy} disabled={!wid || Number(qty) < 1 || reference.trim().length < 3}>Ship</Button>
    </Stack>
  );
}

export function EditItem({ item, facets, onSaved }: { item: Item | null; facets: Facets | undefined; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    sku: "",
    name: item?.name ?? "",
    serialNumber: item?.serialNumber ?? "",
    modelNumber: item?.modelNumber ?? "",
    weightLb: item?.weightKg != null ? kgToLb(item.weightKg) : "",
    lengthIn: item?.lengthCm != null ? cmToIn(item.lengthCm) : "",
    widthIn: item?.widthCm != null ? cmToIn(item.widthCm) : "",
    heightIn: item?.heightCm != null ? cmToIn(item.heightCm) : "",
    brand: item?.brand ?? "",
    category: item?.category ?? "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: form.name,
        serialNumber: form.serialNumber,
        modelNumber: form.modelNumber,
        weightKg: form.weightLb === "" ? null : lbToKg(Number(form.weightLb)),
        lengthCm: form.lengthIn === "" ? null : inToCm(Number(form.lengthIn)),
        widthCm: form.widthIn === "" ? null : inToCm(Number(form.widthIn)),
        heightCm: form.heightIn === "" ? null : inToCm(Number(form.heightIn)),
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
      <TextInput type="text" label="Serial number" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.currentTarget.value })} maxLength={60} />
      <TextInput type="text" label="Model number" value={form.modelNumber} onChange={(e) => setForm({ ...form, modelNumber: e.currentTarget.value })} maxLength={60} />
      <NumberInput label="Weight (lb)" value={form.weightLb} onChange={(weightLb) => setForm({ ...form, weightLb })} min={0} allowNegative={false} step={0.1} />
      <Input.Wrapper label="Length × Width × Height (in)">
        <Group grow gap="xs" wrap="nowrap">
          <NumberInput aria-label="Length (in)" placeholder="Length" value={form.lengthIn} onChange={(lengthIn) => setForm({ ...form, lengthIn })} min={0} allowNegative={false} />
          <NumberInput aria-label="Width (in)" placeholder="Width" value={form.widthIn} onChange={(widthIn) => setForm({ ...form, widthIn })} min={0} allowNegative={false} />
          <NumberInput aria-label="Height (in)" placeholder="Height" value={form.heightIn} onChange={(heightIn) => setForm({ ...form, heightIn })} min={0} allowNegative={false} />
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
