import { Button, Text } from "@mantine/core";
import { type ReactNode, useState } from "react";

const seen = (key: string) => {
  try {
    return localStorage.getItem(`pi.coach.${key}`) === "1";
  } catch {
    return false;
  }
};

/**
 * First-use coaching: a quiet aside the first time someone reaches a screen
 * on this device, gone for good once they tap "Got it". The lime dot marks it
 * as new; the rest stays out of the work's way.
 */
export function Coach({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [hidden, setHidden] = useState(() => seen(id));
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(`pi.coach.${id}`, "1");
    } catch {
      // storage blocked: hide for this visit only
    }
    setHidden(true);
  };
  return (
    <aside className="coach no-print" aria-label={`Tip: ${title}`}>
      <div className="coach-title">{title}</div>
      <Text size="sm" mt={6} mb="xs" maw="68ch">
        {children}
      </Text>
      <Button size="compact-sm" variant="default" onClick={dismiss}>
        Got it
      </Button>
    </aside>
  );
}

export function resetCoaching() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("pi.coach.")) localStorage.removeItem(key);
  } catch {
    // nothing to reset
  }
}
