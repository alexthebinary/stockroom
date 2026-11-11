import { Button, Checkbox, Group, Menu, Text } from "@mantine/core";
import { IconColumns3 } from "@tabler/icons-react";
import { useLocalStore } from "../lib/localStore";
import { useMediaQuery } from "@mantine/hooks";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Ruled, RuledRow } from "./Ruled";

export type Column<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** Fixed pixel width; the one column without a width takes the spare room. */
  width?: number;
  align?: "right";
  mono?: boolean;
  strong?: boolean;
  /** Holds the row's name and its link; exactly one per table. */
  primary?: boolean;
  /** Buttons inside the row: a click here does not open the row. */
  action?: boolean;
  /** Header text is only for screen readers. */
  srOnly?: boolean;
};

/** Tick boxes beside rows (wide screens). Selected rows can be exported and given extra actions. */
export type Selectable<T> = {
  /** One CSV line per selected row: header name -> value. */
  csv?: (row: T) => Record<string, string | number | null | undefined>;
  filename: string;
  /** Extra buttons in the selection bar; `clear` empties the selection. */
  actions?: (selected: T[], clear: () => void) => ReactNode;
};

function downloadCsv(filename: string, rows: Record<string, string | number | null | undefined>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const cell = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = [headers.map(cell).join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type Props<T> = {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: Column<T>[];
  label: string;
  /** Opens a page. */
  to?: (row: T) => string;
  /** Opens something in place (a dialog). */
  onOpen?: (row: T) => void;
  empty: ReactNode;
  /** The two-line version for phones. */
  phone: (row: T) => { title: ReactNode; meta?: ReactNode; aside?: ReactNode };
  selectable?: Selectable<T>;
  /** Names this table so each person can choose which columns show (kept in this browser). */
  id?: string;
  /** Called when a row is hovered or focused, to warm the page it opens. */
  prefetch?: (row: T) => void;
  /** Buttons shown just left of Columns. */
  toolbar?: ReactNode;
};

/** One list pattern for every document and item list: a one-line-per-row table on wide screens, ruled rows on phones. */
export function DataTable<T>({ rows, rowKey, columns: allColumns, label, to, onOpen, empty, phone, selectable, id, prefetch, toolbar }: Props<T>) {
  const wide = useMediaQuery("(min-width: 900px)") ?? true;
  const navigate = useNavigate();
  const [hidden, setHidden] = useLocalStore<string[]>(`pi.cols.${id ?? "_"}`, []);
  const optional = allColumns.filter((c) => !c.primary && !c.action);
  const columns = id ? allColumns.filter((c) => c.primary || c.action || !hidden.includes(c.key)) : allColumns;
  const [picked, setPicked] = useState<Set<string | number>>(new Set());
  // Only rows still in the list stay selected (a filter or refresh can drop some).
  const selected = useMemo(() => rows.filter((r) => picked.has(rowKey(r))), [rows, picked, rowKey]);
  const toggle = (key: string | number) => setPicked((cur) => { const next = new Set(cur); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const allOn = selected.length === rows.length && rows.length > 0;
  const clear = () => setPicked(new Set());
  const primary = columns.find((c) => c.primary);
  const rowName = (row: T) => { const v = primary?.render(row); return typeof v === "string" || typeof v === "number" ? String(v) : String(rowKey(row)); };
  if (rows.length === 0) return <Ruled label={label} empty={empty} />;

  if (!wide) {
    return (
      <Ruled label={label}>
        {rows.map((row) => {
          const { title, meta, aside } = phone(row);
          return onOpen && !to ? (
            <RuledRow key={rowKey(row)} title={<button type="button" className="row-open" onClick={() => onOpen(row)}>{title}</button>} meta={meta} aside={aside} />
          ) : (
            <RuledRow key={rowKey(row)} to={to?.(row)} title={title} meta={meta} aside={aside} />
          );
        })}
      </Ruled>
    );
  }

  const open = (row: T) => (to ? navigate(to(row)) : onOpen?.(row));
  const clickable = Boolean(to || onOpen);
  return (
    <>
    {toolbar || (id && optional.length > 1) ? (
      <Group justify="flex-end" mb="xs" className="no-print" gap="xs">
        {toolbar}
        {id && optional.length > 1 ? (
        <Menu position="bottom-end" closeOnItemClick={false} width={220}>
          <Menu.Target>
            <Button variant="subtle" size="compact-md" leftSection={<IconColumns3 size={16} aria-hidden="true" />}>Columns{hidden.length ? ` (${optional.length - hidden.length} of ${optional.length})` : ""}</Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Show columns</Menu.Label>
            {optional.map((c) => (
              <Menu.Item key={c.key} component="div" p="xs">
                <Checkbox label={c.label} checked={!hidden.includes(c.key)} onChange={() => setHidden(hidden.includes(c.key) ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])} />
              </Menu.Item>
            ))}
            {hidden.length ? <Menu.Item onClick={() => setHidden([])}>Show all</Menu.Item> : null}
          </Menu.Dropdown>
        </Menu>
        ) : null}
      </Group>
    ) : null}
    {selectable && selected.length > 0 ? (
      <Group className="select-bar" role="toolbar" aria-label="Selected rows" justify="space-between" wrap="wrap" gap="xs">
        <Text fw={600} role="status">{selected.length} selected</Text>
        <Group gap="xs">
          {selectable.csv ? (
            <Button size="compact-md" variant="default" onClick={() => downloadCsv(selectable.filename, selected.map(selectable.csv!))}>Export CSV</Button>
          ) : null}
          {selectable.actions?.(selected, clear)}
          <Button size="compact-md" variant="subtle" onClick={clear}>Clear</Button>
        </Group>
      </Group>
    ) : null}
    <table className="data-table">
      <caption className="visually-hidden">{label}</caption>
      <colgroup>
        {selectable ? <col style={{ width: 44 }} /> : null}
        {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>
          {selectable ? (
            <th scope="col" className="sel">
              <Checkbox aria-label={`Select all ${label.toLowerCase()}`} checked={allOn} indeterminate={selected.length > 0 && !allOn} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map(rowKey)))} />
            </th>
          ) : null}
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.align === "right" ? "num" : undefined}>
              {c.srOnly ? <span className="visually-hidden">{c.label}</span> : c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className={clickable ? "data-row" : undefined} data-selected={picked.has(rowKey(row)) ? "true" : undefined} onMouseEnter={prefetch ? () => prefetch(row) : undefined} onFocus={prefetch ? () => prefetch(row) : undefined} onClick={clickable ? () => open(row) : undefined}>
            {selectable ? (
              <td className="sel" onClick={(e) => e.stopPropagation()}>
                <Checkbox aria-label={`Select ${rowName(row)}`} checked={picked.has(rowKey(row))} onChange={() => toggle(rowKey(row))} />
              </td>
            ) : null}
            {columns.map((c) => {
              const cls = [c.align === "right" ? "num" : "", c.mono ? "mono" : "", c.strong ? "strong" : "", c.primary ? "name" : "", c.action ? "act" : ""].filter(Boolean).join(" ");
              const content = c.render(row);
              const title = typeof content === "string" || typeof content === "number" ? String(content) : undefined;
              return (
                <td key={c.key} className={cls || undefined} title={title} onClick={c.action ? (e) => e.stopPropagation() : undefined}>
                  {c.primary && clickable ? (
                    to ? (
                      <Link className="row-link" to={to(row)} onClick={(e) => e.stopPropagation()}>{content}</Link>
                    ) : (
                      <button type="button" className="row-link" onClick={(e) => { e.stopPropagation(); onOpen?.(row); }}>{content}</button>
                    )
                  ) : content}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}
