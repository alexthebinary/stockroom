import { Badge, Button, Card, Group, Modal, Select, SimpleGrid, Stack, Tabs, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTruck } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { DataTable } from "../../components/DataTable";
import { plural, formatDate, Loading, Money, PageHeader, StatusBadge, toastErr, toastOk } from "../../components/ui";
import { get, post } from "../../lib/api";
import type { Bill, Item } from "../../lib/types";

const KIND = { INVENTORY: "Stock", FREIGHT_IN: "Freight in", FREIGHT_OUT: "Freight out" } as const;
const days = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
/** A draft shows how long it has waited; a posted bill shows when it is due. */
const dueOrAge = (b: Bill) => (b.status === "DRAFT" ? `${plural(days(b.createdAt), "day")} old` : formatDate(b.dueDate));

/** The accounting inbox: what the dock received that needs a bill, then what's posted and unpaid. */
export function BillDesk() {
  const bills = useQuery({ queryKey: ["bills"], queryFn: () => get<Bill[]>("/bills"), refetchInterval: 30_000 });
  const unknown = useQuery({ queryKey: ["unknown"], queryFn: () => get<{ sessionId: number; code: string | null; name: string | null; qty: number; startedBy: string; submittedAt: string }[]>("/receiving/unknown") });
  const [tab, setTab] = useState<string | null>("review");
  if (!bills.data) return <><PageHeader title="Bills" /><Loading /></>;
  const drafts = bills.data.filter((b) => b.status === "DRAFT");
  const open = bills.data.filter((b) => b.status === "POSTED" && (b.openCents ?? 0) !== 0);
  const shown = tab === "review" ? drafts : tab === "open" ? open : bills.data;
  return (
    <>
      <PageHeader
        title="Bills"
        subtitle="Vendor bills are the only purchase documents that post money. Review what the dock received, then post."
        action={
          <Button component={Link} to="/bills/freight/new" leftSection={<IconTruck size={18} />} variant="light">
            Freight bill
          </Button>
        }
      />
      <Coach id="bill-desk" title="From the dock to the books">
        Each draft here holds units the clerk already counted. Posting it books Inventory against Accounts Payable at landed cost and makes those units sellable.
      </Coach>
      <Tabs value={tab} onChange={setTab} mb="md">
        <Tabs.List>
          <Tabs.Tab value="review" rightSection={drafts.length ? <Badge size="sm">{drafts.length}</Badge> : null}>
            To review
          </Tabs.Tab>
          <Tabs.Tab value="open" rightSection={open.length ? <Badge size="sm" color="gray">{open.length}</Badge> : null}>
            Unpaid
          </Tabs.Tab>
          <Tabs.Tab value="unknown" rightSection={unknown.data?.length ? <Badge size="sm" color="orange">{unknown.data.length}</Badge> : null}>
            Unknown items
          </Tabs.Tab>
          <Tabs.Tab value="all">All</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === "unknown" ? (
        <UnknownItems rows={unknown.data ?? []} />
      ) : (
        <DataTable
          id="bills"
          label="Bills"
          rows={shown}
          rowKey={(b) => b.id}
          to={(b) => `/bills/${b.id}`}
          selectable={{ filename: "bills-selected.csv", csv: (b) => ({ Bill: b.number, "Bill date": formatDate(b.billDate), "Due / age": dueOrAge(b), Vendor: b.vendor?.name, Type: KIND[b.kind] ?? b.kind, "Vendor invoice": b.vendorInvoiceNumber, Status: b.status, Amount: (((b.status === "POSTED" ? b.openCents : b.totalCents) ?? 0) / 100).toFixed(2) }) }}
          empty={tab === "review" ? "Nothing to review. When the dock receives a delivery that isn't billed yet, its draft bill appears here." : "Nothing here."}
          columns={[
            { key: "number", label: "Bill", width: 130, primary: true, strong: true, render: (b) => b.number },
            { key: "billDate", label: "Bill date", width: 130, render: (b) => formatDate(b.billDate) },
            { key: "vendor", label: "Vendor", render: (b) => b.vendor?.name ?? "Vendor not set" },
            { key: "kind", label: "Type", width: 130, render: (b) => KIND[b.kind] },
            { key: "invoice", label: "Vendor invoice", width: 150, render: (b) => b.vendorInvoiceNumber ?? "—" },
            { key: "when", label: "Due / age", width: 150, render: dueOrAge },
            { key: "units", label: "Waiting", width: 100, align: "right", render: (b) => (b.heldUnits ? plural(b.heldUnits, "unit") : "—") },
            { key: "status", label: "Status", width: 120, render: (b) => <StatusBadge status={b.status} /> },
            { key: "amount", label: "Amount", width: 120, align: "right", strong: true, render: (b) => <Money cents={b.status === "POSTED" ? b.openCents : b.totalCents} /> },
          ]}
          phone={(b) => ({
            title: (
              <>
                {b.vendor?.name ?? "Vendor not set"}
                <Text span c="dimmed" fw={400} size="sm">
                  {" "}
                  · {KIND[b.kind]}
                </Text>
              </>
            ),
            meta: (
              <>
                {b.number}
                {b.vendorInvoiceNumber ? ` · invoice ${b.vendorInvoiceNumber}` : ""}
                {b.status === "DRAFT" ? ` · ${b.source === "SCAN" ? "from the dock, " : ""}${plural(days(b.createdAt), "day")} old` : ` · due ${formatDate(b.dueDate)}`}
                {b.heldUnits ? ` · ${plural(b.heldUnits, "unit")} waiting` : ""}
              </>
            ),
            aside: (
              <>
                <Text fw={600}>
                  <Money cents={b.status === "POSTED" ? b.openCents : b.totalCents} />
                </Text>
                <StatusBadge status={b.status} />
              </>
            ),
          })}
        />
      )}
    </>
  );
}

type UnknownRow = { sessionId: number; code: string | null; name: string | null; qty: number; startedBy: string; submittedAt: string };
type Suggestion = { itemId: number; name: string; reason: string };
type SuggestionBody = { judgmentId: number | null; suggestions: Suggestion[] };

function UnknownItems({ rows }: { rows: UnknownRow[] }) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<{ row: UnknownRow; judgmentId: number | null; suggestedIds: number[] } | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const match = async (row: UnknownRow, chosenId: number, judgmentId: number | null, suggestedIds: number[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await post(`/scan-sessions/${row.sessionId}/resolve`, { code: row.code, name: row.name, itemId: chosenId, learn: row.code != null });
      if (judgmentId != null) {
        const outcome = suggestedIds.includes(chosenId) ? "ACCEPTED" : "CORRECTED";
        try {
          await post(`/ai/judgments/${judgmentId}/outcome`, { outcome, value: { itemId: chosenId } });
        } catch {
          // The match is already saved. A missed note must not look like a failed match.
        }
      }
      toastOk("Matched. The barcode is learned and the units are on their order.");
      setMapping(null);
      setItemId(null);
      queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  if (rows.length === 0) return <Text c="dimmed">No unknown items. Everything scanned matched the catalog.</Text>;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {rows.map((row, i) => (
        <UnknownCard
          key={i}
          row={row}
          busy={busy}
          onSuggest={(suggestion, body) => match(row, suggestion.itemId, body.judgmentId, body.suggestions.map((s) => s.itemId))}
          onChoose={(body) => {
            setItemId(null);
            setMapping({ row, judgmentId: body?.judgmentId ?? null, suggestedIds: body?.suggestions.map((s) => s.itemId) ?? [] });
          }}
        />
      ))}
      <Modal opened={mapping != null} onClose={() => setMapping(null)} title="Match to an item">
        <Stack>
          <Text size="sm" c="dimmed">
            The barcode is remembered, so next time it scans straight away. The units go onto the delivery's order and wait for its bill.
          </Text>
          <Select data={(items.data ?? []).filter((i) => i.trackingMode === "NONE" && !i.isBundle).map((i) => ({ value: String(i.id), label: `${i.sku} · ${i.name}` }))} value={itemId} onChange={setItemId} searchable label="Item" />
          <Text size="xs" c="dimmed">
            Serial-tracked items need each unit's serial: receive those through a new delivery.
          </Text>
          <Button onClick={() => mapping && itemId && match(mapping.row, Number(itemId), mapping.judgmentId, mapping.suggestedIds)} disabled={!itemId || busy}>
            Match
          </Button>
        </Stack>
      </Modal>
    </SimpleGrid>
  );
}

function UnknownCard({ row, busy, onSuggest, onChoose }: { row: UnknownRow; busy: boolean; onSuggest: (suggestion: Suggestion, body: SuggestionBody) => void; onChoose: (body: SuggestionBody | null) => void }) {
  const params = new URLSearchParams({ sessionId: String(row.sessionId) });
  if (row.code) params.set("code", row.code);
  if (row.name) params.set("name", row.name);
  const suggestions = useQuery({
    queryKey: ["unknown-suggestions", row.sessionId, row.code, row.name],
    retry: false,
    queryFn: async (): Promise<SuggestionBody> => {
      try {
        return await get<SuggestionBody>(`/ai/unknown-suggestions?${params.toString()}`);
      } catch {
        return { judgmentId: null, suggestions: [] };
      }
    },
  });
  const body = suggestions.data ?? null;
  const list = body?.suggestions ?? [];
  return (
    <Card withBorder className="section">
      <Text fw={600}>{row.name ?? "No description"}</Text>
      <Text size="sm" c="dimmed">
        Code {row.code ?? "—"} · {plural(row.qty, "unit")} · scanned by {row.startedBy} {formatDate(row.submittedAt)}
      </Text>
      <Stack gap="xs" mt="sm">
        {list.map((suggestion) => (
          <div key={suggestion.itemId}>
            <Button variant="light" disabled={busy} onClick={() => body && onSuggest(suggestion, body)}>
              Match to {suggestion.name}
            </Button>
            <Text size="xs" c="dimmed">
              {suggestion.reason}
            </Text>
          </div>
        ))}
        <Button variant="light" disabled={busy} onClick={() => onChoose(body)} leftSection={<IconPlus size={16} />}>
          Match to an item
        </Button>
      </Stack>
    </Card>
  );
}
