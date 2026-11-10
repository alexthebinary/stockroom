import { Children, type ReactNode } from "react";
import { IconInbox } from "@tabler/icons-react";
import { Link } from "react-router-dom";

/** A datasheet list: hairline rows under one ink rule. Rows with `to` are tappable and say so on hover. */
export function Ruled({ children, empty, label }: { children?: ReactNode; empty?: ReactNode; label?: string }) {
  const items = Children.toArray(children);
  return (
    <div className="ruled" role="list" aria-label={label}>
      {items.length ? children : <div className="ruled-empty"><IconInbox size={20} aria-hidden="true" /><div>{empty}</div></div>}
    </div>
  );
}

export function RuledRow({ to, title, meta, aside }: { to?: string; title: ReactNode; meta?: ReactNode; aside?: ReactNode }) {
  const body = (
    <>
      <div style={{ minWidth: 0 }}>
        <div className="ruled-row-title">{title}</div>
        {meta ? <div className="ruled-row-meta">{meta}</div> : null}
      </div>
      {aside ? <div className="ruled-row-aside">{aside}</div> : <span />}
    </>
  );
  return to ? (
    <div role="listitem">
      <Link className="ruled-row" to={to}>
        {body}
      </Link>
    </div>
  ) : (
    <div className="ruled-row" role="listitem">
      {body}
    </div>
  );
}
