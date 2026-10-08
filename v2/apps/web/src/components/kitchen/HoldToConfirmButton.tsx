import { IconCheck } from "@tabler/icons-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * For actions that move money: the fill grows while you hold, and only a
 * full hold commits. Letting go, sliding off, or tabbing away cancels.
 * Keyboard users hold Enter or Space. Adapted from dqnamo's Kitchen.
 */
type Props = {
  children: ReactNode;
  onConfirm: () => void;
  tone?: "signal" | "danger";
  /** How long to hold, in ms. Deliberate, not slow. */
  duration?: number;
  disabled?: boolean;
  busy?: boolean;
  confirmed?: ReactNode;
  hint?: string;
  fullWidth?: boolean;
};

type Status = "idle" | "holding" | "confirmed";

export function HoldToConfirmButton({ children, onConfirm, tone = "signal", duration = 900, disabled, busy, confirmed, hint = "Press and hold", fullWidth }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const pointer = useRef<number | null>(null);
  const holding = useRef(false);
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState<"pointer" | "keyboard">("pointer");
  const inert = disabled || busy;

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const complete = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    pointer.current = null;
    clear();
    setStatus("confirmed");
    navigator.vibrate?.(30);
    onConfirm();
  }, [onConfirm]);
  const cancel = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    pointer.current = null;
    clear();
    setStatus("idle");
  }, []);
  const start = (how: "pointer" | "keyboard") => {
    if (inert || holding.current || status === "confirmed") return;
    setInput(how);
    holding.current = true;
    setStatus("holding");
    timer.current = window.setTimeout(complete, duration);
  };

  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (inert) cancel();
  }, [inert, cancel]);
  // Back to idle when the work that followed is done (busy → false).
  useEffect(() => {
    if (!busy && status === "confirmed") {
      const t = window.setTimeout(() => setStatus("idle"), 600);
      return () => window.clearTimeout(t);
    }
  }, [busy, status]);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary || e.button !== 0 || inert) return;
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    start("pointer");
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!holding.current || pointer.current !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pad = 12;
    if (e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) cancel();
  };
  const onPointerEnd = (e: PointerEvent<HTMLButtonElement>) => {
    if (pointer.current === e.pointerId) cancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    start("keyboard");
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    cancel();
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`hold hold-${tone}${fullWidth ? " hold-full" : ""}`}
      data-status={status}
      data-input={input}
      style={{ ["--hold-duration" as string]: `${duration}ms` }}
      aria-disabled={inert || undefined}
      aria-busy={busy || status === "holding"}
      aria-description={`${hint} to confirm`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {status === "confirmed" ? (
        <span className="hold-label">
          <IconCheck size={18} stroke={2.5} aria-hidden="true" />
          {confirmed ?? children}
        </span>
      ) : (
        <>
          <span className="hold-label">{children}</span>
          <span className="hold-fill" aria-hidden="true">
            <span className="hold-label">{children}</span>
          </span>
        </>
      )}
    </button>
  );
}
