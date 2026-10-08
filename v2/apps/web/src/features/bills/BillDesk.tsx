import { Badge, Button, Card, Group, Modal, Select, SimpleGrid, Stack, Tabs, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTruck } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Coach } from "../../components/Coach";
import { Ruled, RuledRow } from "../../components/Ruled";
import { plural, formatDate, Loading, Money, PageHeader, StatusBadge, toastErr, toastOk } from "../../components/ui";
import { get, post } from "../../lib/api";
import type { Bill, Item } from "../../lib/types";

const KIND = { INVENTORY: "Stock", FREIGHT_IN: "Freight in", FREIGHT_OUT: "Freight out" } as const;
const days = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

/** The accounting inbox: what the dock received that needs a bill, then what's posted and unpaid. */
export function BillDesk() {
  const bills = useQuery({ queryKey: ["bills"], queryFn: () => get<Bill[]>("/bills"), refetchInterval: 30_000 });
  const unknown = useQuery({ queryKey: ["unknown"], queryFn: () => get<{ sessionId: number; code: string | null; name: string | null; qty: number; startedBy: string; submittedAt: string }[]>("/receiving/unknown") });
  const [tab, setTab] = useState<string | null>("review");
  if (!bills.data) return <Loading />;
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
        <Ruled label="Bills" empty={tab === "review" ? "Nothing to review. When the dock receives a delivery that isn't billed yet, its draft bill appears here." : "Nothing here."}>
          {shown.map((b) => (
            <RuledRow
              key={b.id}
              to={`/bills/${b.id}`}
              title={
                <>
                  {b.vendor?.name ?? "Vendor not set"}
                  <Text span c="dimmed" fw={400} size="sm">
                    {" "}
                    · {KIND[b.kind]}
                  </Text>
                </>
              }
              meta={
                <>
                  {b.number}
                  {b.vendorInvoiceNumber ? ` · invoice ${b.vendorInvoiceNumber}` : ""}
                  {b.status === "DRAFT" ? ` · ${b.source === "SCAN" ? "from the dock, " : ""}${plural(days(b.createdAt), "day")} old` : ` · due ${formatDate(b.dueDate)}`}
                  {b.heldUnits ? ` · ${plural(b.heldUnits, "unit")} waiting` : ""}
                </>
              }
              aside={
                <>
                  <Text fw={600}>
                    <Money cents={b.status === "POSTED" ? b.openCents : b.totalCents} />
                  </Text>
                  <StatusBadge status={b.status} />
                </>
              }
            />
          ))}
        </Ruled>
      )}
    </>
  );
}

function UnknownItems({ rows }: { rows: { sessionId: number; code: string | null; name: string | null; qty: number; startedBy: string; submittedAt: string }[] }) {
  const items = useQuery({ queryKey: ["items"], queryFn: () => get<Item[]>("/items") });
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<(typeof rows)[number] | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const resolve = async () => {
    if (!mapping) return;
    try {
      await post(`/scan-sessions/${mapping.sessionId}/resolve`, { code: mapping.code, name: mapping.name, itemId: Number(itemId), learn: mapping.code != null });
      toastOk("Matched. The barcode is learned and the units are on their order.");
      setMapping(null);
      setItemId(null);
      queryClient.invalidateQueries();
    } catch (error) {
      toastErr(error);
    }
  };
  if (rows.length === 0) return <Text c="dimmed">No unknown items. Everything scanned matched the catalog.</Text>;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {rows.map((r, i) => (
        <Card key={i} withBorder>
          <Text fw={600}>{r.name ?? "No description"}</Text>
          <Text size="sm" c="dimmed">
            Code {r.code ?? "—"} · {plural(r.qty, "unit")} · scanned by {r.startedBy} {formatDate(r.submittedAt)}
          </Text>
          <Button mt="sm" variant="light" onClick={() => setMapping(r)} leftSection={<IconPlus size={16} />}>
            Match to an item
          </Button>
        </Card>
      ))}
      <Modal opened={mapping != null} onClose={() => setMapping(null)} title="Match to an item">
        <Stack>
          <Text size="sm" c="dimmed">
            The barcode is remembered, so next time it scans straight away. The units go onto the delivery's order and wait for its bill.
          </Text>
          <Select data={(items.data ?? []).filter((i) => i.trackingMode === "NONE").map((i) => ({ value: String(i.id), label: `${i.sku} · ${i.name}` }))} value={itemId} onChange={setItemId} searchable label="Item" />
          <Text size="xs" c="dimmed">
            Serial-tracked items need each unit's serial: receive those through a new delivery.
          </Text>
          <Button onClick={resolve} disabled={!itemId}>
            Match
          </Button>
        </Stack>
      </Modal>
    </SimpleGrid>
  );
}
