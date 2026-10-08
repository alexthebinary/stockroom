import { Alert, Button, Group, Text } from "@mantine/core";
import { IconBulb } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";

const seen = (key: string) => {
  try {
    return localStorage.getItem(`pi.coach.${key}`) === "1";
  } catch {
    return false;
  }
};

/**
 * First-use coaching: a tip shown the first time someone reaches a screen on
 * this device, gone for good once they tap "Got it".
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
    <Alert icon={<IconBulb size={18} />} color="lime" variant="light" title={title} mb="md" className="no-print">
      <Text size="sm" mb="xs">
        {children}
      </Text>
      <Group>
        <Button size="xs" variant="light" color="lime" onClick={dismiss}>
          Got it
        </Button>
      </Group>
    </Alert>
  );
}

export function resetCoaching() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("pi.coach.")) localStorage.removeItem(key);
  } catch {
    // nothing to reset
  }
}
