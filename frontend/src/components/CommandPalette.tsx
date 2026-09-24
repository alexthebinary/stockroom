import { Badge, Kbd, Loader, Modal, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowRight, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs, type Attention } from "../api";
import { money } from "./ui";
import { ALL_DESTINATIONS } from "../nav";

type Row = {
  key: string;
  group: string;
  label: string;
  detail?: string;
  trailing?: string;
  to: string;
  urgent?: boolean;
};

/** Things you can start from anywhere, not places you can go. */
/** `also` holds the other words people type for the same job ("new sale" finds the counter). */
const ACTIONS: { label: string; detail: string; to: string; needs?: "stock" | "money"; also?: string[] }[] = [
  { label: "Receive a delivery", detail: "Scan boxes in against a purchase order", to: "/receive", needs: "stock", also: ["delivery", "arrived", "scan"] },
  { label: "Store", detail: "A walk-in client pays and takes the goods (showroom sale)", to: "/showroom", needs: "money", also: ["new sale", "counter", "walk-in", "checkout", "pos"] },
  { label: "New sales order", detail: "Sell to a customer", to: "/sales-orders", also: ["order", "wholesale"] },
  { label: "Record a return", detail: "Open the shipped order and press Return items", to: "/sales-orders", also: ["return", "refund", "rma"] },
  { label: "New purchase order", detail: "Buy from a vendor", to: "/purchase-orders" },
  { label: "Move stock between warehouses", detail: "Start a transfer", to: "/transfers", needs: "stock" },
  { label: "Correct a count", detail: "Record a stock adjustment", to: "/adjustments", needs: "stock" },
];

/**
 * ⌘K.
 *
 * Opens on WHAT NEEDS DOING rather than an empty box, because the operator
 * arrives with a task, not a query. Typing then searches the things a
 * warehouse is actually navigated by — a SKU on a box, a PO on a delivery
 * note, a serial on a unit — which previously took five interactions to reach
 * through the menus even when you were holding the number.
 */
export function CommandPalette({
  opened,
  onClose,
  attention,
  can,
}: {
  opened: boolean;
  onClose: () => void;
  attention?: Attention;
  can: { stock: boolean; money: boolean; users: boolean };
}) {
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query, 180);
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  const search = useQuery({
    queryKey: ["command-search", debounced],
    queryFn: () =>
      api.get<{ results: { kind: string; label: string; detail: string; to: string; amountCents?: number }[] }>(
        `/dashboard/search${qs({ q: debounced })}`
      ),
    enabled: opened && debounced.trim().length >= 2,
  });

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();

    // Nothing typed: lead with the work, not with a blank list.
    if (!q && attention) {
      const work: Row[] = [];
      if (attention.invoices.unpaid > 0)
        work.push({
          key: "a-inv", group: "Needs attention",
          label: `${attention.invoices.unpaid} invoice${attention.invoices.unpaid === 1 ? "" : "s"} unpaid`,
          detail: attention.invoices.overdue > 0 ? `${attention.invoices.overdue} over 30 days` : "Chase payment",
          trailing: money(attention.invoices.outstandingCents),
          to: "/invoices?settlement=UNPAID", urgent: attention.invoices.overdue > 0,
        });
      if (attention.receipts.ordersShort > 0)
        work.push({
          key: "a-rec", group: "Needs attention",
          label: `${attention.receipts.ordersShort} order${attention.receipts.ordersShort === 1 ? "" : "s"} short`,
          detail: "Goods ordered and not fully received", to: "/receipts", urgent: true,
        });
      if (attention.stock.belowReorderPoint > 0)
        work.push({
          key: "a-stock", group: "Needs attention",
          label: `${attention.stock.belowReorderPoint} item${attention.stock.belowReorderPoint === 1 ? "" : "s"} below reorder point`,
          detail: "Reorder before you run out", to: "/inventory", urgent: true,
        });
      if (attention.bills.unpaid > 0 && can.money)
        work.push({
          key: "a-bill", group: "Needs attention",
          label: `${attention.bills.unpaid} bill${attention.bills.unpaid === 1 ? "" : "s"} to pay`,
          detail: "Owed to vendors", trailing: money(attention.bills.outstandingCents),
          to: "/bills?settlement=UNPAID",
        });
      if (attention.deliveries.inTransit > 0)
        work.push({
          key: "a-del", group: "Needs attention",
          label: `${attention.deliveries.inTransit} shipment${attention.deliveries.inTransit === 1 ? "" : "s"} in transit`,
          detail: "Nobody has confirmed arrival", to: "/deliveries?delivered=NO",
        });

      return [
        ...work,
        ...ACTIONS.filter((a) => !a.needs || can[a.needs]).map((a) => ({
          key: `act-${a.to}-${a.label}`, group: "Start", label: a.label, detail: a.detail, to: a.to,
        })),
      ];
    }

    const destinations = ALL_DESTINATIONS.filter(
      (d) => (!d.needs || can[d.needs]) && d.label.toLowerCase().includes(q)
    ).map((d) => ({ key: `go-${d.to}-${d.label}`, group: "Go to", label: d.label, detail: d.group, to: d.to }));

    const actions = ACTIONS.filter(
      (a) =>
        (!a.needs || can[a.needs]) &&
        (a.label.toLowerCase().includes(q) || (a.also ?? []).some((w) => w.includes(q) || q.includes(w)))
    ).map((a) => ({ key: `act-${a.label}`, group: "Start", label: a.label, detail: a.detail, to: a.to }));

    const records = (search.data?.results ?? []).map((r, i) => ({
      key: `rec-${i}-${r.label}`, group: r.kind, label: r.label, detail: r.detail,
      trailing: r.amountCents !== undefined ? money(r.amountCents) : undefined, to: r.to,
    }));

    return [...actions, ...destinations, ...records];
  }, [query, attention, can, search.data]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (opened) {
      setQuery("");
      setCursor(0);
    }
  }, [opened]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const go = (row?: Row) => {
    if (!row) return;
    navigate(row.to);
    onClose();
  };

  let lastGroup = "";

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      withCloseButton={false}
      padding={0}
      radius={12}
      size={560}
      yOffset="12vh"
      overlayProps={{ backgroundOpacity: 0.35, blur: 3 }}
      classNames={{ content: "palette" }}
    >
      <TextInput
        autoFocus
        variant="unstyled"
        size="md"
        placeholder="Search orders, SKUs, serials, invoices — or jump to a page"
        leftSection={<IconSearch size={17} stroke={1.8} />}
        rightSection={search.isFetching ? <Loader size={14} /> : null}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="palette-input"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(rows[cursor]);
          }
        }}
      />

      <div className="palette-list" ref={listRef}>
        {rows.length === 0 && (
          <Text className="palette-empty">
            {query.trim().length === 1
              ? "Keep typing — two characters to search."
              : search.isFetching
                ? "Searching…"
                : "Nothing matches that."}
          </Text>
        )}
        {rows.map((row, i) => {
          const header = row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;
          return (
            <div key={row.key}>
              {header && <div className="palette-group">{header}</div>}
              <button
                type="button"
                className="palette-row"
                data-selected={i === cursor || undefined}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(row)}
              >
                <span className="palette-row-main">
                  <span className="palette-row-label">
                    {row.label}
                    {row.urgent && (
                      <Badge size="xs" variant="light" color="orange" ml={8}>
                        now
                      </Badge>
                    )}
                  </span>
                  {row.detail && <span className="palette-row-detail">{row.detail}</span>}
                </span>
                {row.trailing && <span className="palette-row-trailing">{row.trailing}</span>}
                <IconArrowRight size={14} stroke={1.8} className="palette-row-go" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="palette-foot">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span><Kbd>↵</Kbd> open</span>
        <span><Kbd>esc</Kbd> close</span>
      </div>
    </Modal>
  );
}
