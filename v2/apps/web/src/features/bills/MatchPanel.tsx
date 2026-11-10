import { Stack, Table, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconInfoCircle } from "@tabler/icons-react";
import { usd } from "../../components/ui";

/** Same shape as the bill GET `match` field. Status wording matches `matchStatus` in routes/purchasing.ts. */
export type MatchTone = "ok" | "warn" | "note";
export type MatchNote = { text: string; tone: MatchTone };
export type OrderMatch = {
  billLineId: number;
  itemId: number | null;
  itemName: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  qtyThisBill: number;
  qtyAllBills: number;
  orderUnitCostCents: number;
  billUnitCostCents: number;
  pricePercent: number | null;
  statuses: MatchNote[];
};

type CurrentLine = { billLineId: number; qty: number; unitCostCents: number | null };

/** Signed percent, or null when the order cost is 0 or the gap is 1% or less. */
function priceDriftPercent(orderUnitCostCents: number, billUnitCostCents: number): number | null {
  if (orderUnitCostCents <= 0) return null;
  const delta = billUnitCostCents - orderUnitCostCents;
  if (Math.abs(delta) * 100 <= orderUnitCostCents) return null;
  return Math.round((delta / orderUnitCostCents) * 10000) / 100;
}

function formatSignedPercent(percent: number): string {
  const sign = percent > 0 ? "+" : "-";
  const body = (Math.round(Math.abs(percent) * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${sign}${body}%`;
}

function matchStatus(input: {
  qtyOrdered: number;
  qtyReceived: number;
  qtyAllBills: number;
  orderUnitCostCents: number;
  billUnitCostCents: number;
}): MatchNote[] {
  const notes: MatchNote[] = [];
  const percent = priceDriftPercent(input.orderUnitCostCents, input.billUnitCostCents);
  if (percent != null) notes.push({ text: `Price differs by ${formatSignedPercent(percent)}`, tone: "warn" });
  else if (input.orderUnitCostCents <= 0 && input.billUnitCostCents !== input.orderUnitCostCents) notes.push({ text: "Price differs", tone: "warn" });
  if (input.qtyAllBills > input.qtyOrdered) notes.push({ text: "Billing more than ordered", tone: "warn" });
  if (input.qtyAllBills > input.qtyReceived) notes.push({ text: "Billing more than received", tone: "note" });
  if (notes.length === 0) notes.push({ text: "Matches", tone: "ok" });
  return notes;
}

function StatusChip({ note }: { note: MatchNote }) {
  const Icon = note.tone === "ok" ? IconCheck : note.tone === "note" ? IconInfoCircle : IconAlertTriangle;
  return (
    <Text component="span" size="sm" c={note.tone === "warn" ? "var(--warn-fg)" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
      <Icon size={14} aria-hidden="true" />
      {note.text}
    </Text>
  );
}

/**
 * Advisory check against the purchase order. It never gates Save or Hold to post.
 * On a draft, pass the quantities and unit costs currently in the form so the chips follow the edit.
 * A null unit cost means the field is mid-entry; the saved cost stays until it parses.
 */
export function MatchPanel({ match, current }: { match: OrderMatch[] | null; current?: CurrentLine[] }) {
  if (!match || match.length === 0) return null;
  const rows = match.map((row) => {
    const live = current?.find((c) => c.billLineId === row.billLineId);
    const qty = live?.qty ?? row.qtyThisBill;
    const costKnown = live?.unitCostCents != null;
    const billUnitCostCents = live?.unitCostCents ?? row.billUnitCostCents;
    const dirty = qty !== row.qtyThisBill || (costKnown && billUnitCostCents !== row.billUnitCostCents);
    const view = {
      qtyOrdered: row.qtyOrdered,
      qtyReceived: row.qtyReceived,
      qtyAllBills: row.qtyAllBills - row.qtyThisBill + qty,
      orderUnitCostCents: row.orderUnitCostCents,
      billUnitCostCents,
    };
    return { ...row, qtyThisBill: qty, ...view, statuses: dirty ? matchStatus(view) : row.statuses };
  });
  return (
    <Stack gap="xs">
      <Title order={3} mb="sm">
        Match to order
      </Title>
      <Table.ScrollContainer minWidth={760}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th ta="right">Ordered</Table.Th>
              <Table.Th ta="right">Received</Table.Th>
              <Table.Th ta="right">This bill</Table.Th>
              <Table.Th ta="right">All bills</Table.Th>
              <Table.Th ta="right">Order cost</Table.Th>
              <Table.Th ta="right">Bill cost</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.billLineId}>
                <Table.Td style={{ minWidth: "9rem" }}>{row.itemName ?? "Item"}</Table.Td>
                <Table.Td ta="right">{row.qtyOrdered}</Table.Td>
                <Table.Td ta="right">{row.qtyReceived}</Table.Td>
                <Table.Td ta="right">{row.qtyThisBill}</Table.Td>
                <Table.Td ta="right">{row.qtyAllBills}</Table.Td>
                <Table.Td ta="right">{usd(row.orderUnitCostCents)}</Table.Td>
                <Table.Td ta="right">{usd(row.billUnitCostCents)}</Table.Td>
                <Table.Td>
                  <Stack gap={4}>
                    {row.statuses.map((note) => (
                      <StatusChip key={note.text} note={note} />
                    ))}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Text size="sm" c="dimmed">
        Billing more than received is allowed. Units can be billed before they arrive. This check does not block saving or posting.
      </Text>
    </Stack>
  );
}
