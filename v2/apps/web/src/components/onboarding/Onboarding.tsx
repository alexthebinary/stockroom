import { IconCheck, IconChevronLeft } from "@tabler/icons-react";
import { type ReactNode, useId } from "react";
import "./onboarding.css";

/**
 * The onboarding frame: a back button and progress segments on top, one
 * question in the middle, its actions at the thumb. On a laptop the stage
 * beside it shows a live picture of what the person is building.
 */
export function OnboardingFrame({
  stepKey,
  dir = "next",
  progress,
  onBack,
  stage,
  stageCaption,
  footer,
  children,
}: {
  stepKey: string;
  dir?: "next" | "back";
  progress?: { index: number; total: number } | null;
  onBack?: () => void;
  stage?: ReactNode;
  stageCaption?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ob" data-stage={stage ? "true" : "false"}>
      <div className="ob-main">
        <header className="ob-top">
          {onBack ? (
            <button type="button" className="ob-back" onClick={onBack} aria-label="Back">
              <IconChevronLeft size={24} stroke={2} />
            </button>
          ) : (
            <span />
          )}
          {progress ? <Segments {...progress} /> : <span />}
          <span />
        </header>
        <main className="ob-body">
          <div key={stepKey} className="ob-step" data-dir={dir}>
            <div className="ob-content">{children}</div>
            {footer ? <div className="ob-foot">{footer}</div> : null}
          </div>
        </main>
      </div>
      {stage ? (
        <aside className="ob-stage" aria-hidden="true">
          <div className="ob-plate">
            <span className="ob-plate-mark">
              <img src="/icon.svg" alt="" />
              ProfitIndex
            </span>
            <div key={stepKey} className="ob-visual">
              {stage}
            </div>
            {stageCaption ? <p className="ob-plate-caption">{stageCaption}</p> : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function Segments({ index, total }: { index: number; total: number }) {
  return (
    <div className="ob-segments" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-valuetext={`Step ${index + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="ob-segment" data-state={i < index ? "done" : i === index ? "current" : "todo"} />
      ))}
    </div>
  );
}

export function StepTitle({ title, lede }: { title: ReactNode; lede?: ReactNode }) {
  return (
    <>
      <h1 className="ob-title">{title}</h1>
      {lede ? <p className="ob-lede">{lede}</p> : null}
    </>
  );
}

/** A big option that behaves as a radio. Put a group of them in `role="radiogroup"`. */
export function Choice({
  icon,
  title,
  badge,
  text,
  checked,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  text: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <button type="button" role="radio" aria-checked={checked} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="ob-choice" onClick={onSelect} disabled={disabled}>
      <span className="ob-choice-icon">{icon}</span>
      <span>
        <span className="ob-choice-title">
          <span id={`${id}-t`}>{title}</span>
          {badge}
        </span>
        <span id={`${id}-d`} className="ob-choice-text">
          {text}
        </span>
      </span>
      <span className="ob-choice-tick" aria-hidden="true">
        <IconCheck size={14} stroke={3} />
      </span>
    </button>
  );
}

/** Small options as chips (a role, a kind of vendor), behaving as radios. */
export function Chips<T extends string>({
  label,
  value,
  onChange,
  options,
  row,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  row?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`ob-chips${row ? " ob-chip-row" : ""}`}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className="ob-chip" onClick={() => onChange(option.value)}>
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

const TONES = ["#111210", "#33362f", "#51554a", "#2b3a1e", "#3a3326", "#1f2f33"];

/** Initials on a quiet ink tone picked from the name, so each person keeps theirs. */
export function Avatar({ name, size = 40, you }: { name: string; size?: number; you?: boolean }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <span className="ob-avatar" data-you={you ? "true" : undefined} aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.38, background: TONES[hash % TONES.length] }}>
      {initials}
    </span>
  );
}
