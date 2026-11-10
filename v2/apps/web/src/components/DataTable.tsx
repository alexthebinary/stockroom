import { useMediaQuery } from "@mantine/hooks";
import type { ReactNode } from "react";
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
};

/** One list pattern for every document and item list: a one-line-per-row table on wide screens, ruled rows on phones. */
export function DataTable<T>({ rows, rowKey, columns, label, to, onOpen, empty, phone }: Props<T>) {
  const wide = useMediaQuery("(min-width: 900px)") ?? true;
  const navigate = useNavigate();
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
    <table className="data-table">
      <caption className="visually-hidden">{label}</caption>
      <colgroup>
        {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.align === "right" ? "num" : undefined}>
              {c.srOnly ? <span className="visually-hidden">{c.label}</span> : c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className={clickable ? "data-row" : undefined} onClick={clickable ? () => open(row) : undefined}>
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
  );
}
