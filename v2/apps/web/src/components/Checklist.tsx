import { Anchor, Card, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type Task = { label: string; done: boolean; to?: string; hint?: ReactNode };

/** "Getting started": the first few real things to do, ticked off as they happen; gone once all are done. */
export function Checklist({ title = "Getting started", tasks }: { title?: string; tasks: Task[] }) {
  if (tasks.every((t) => t.done)) return null;
  const done = tasks.filter((t) => t.done).length;
  return (
    <Card withBorder className="no-print">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{title}</Text>
        <Text size="sm" c="dimmed">
          {done} of {tasks.length}
        </Text>
      </Group>
      <Stack gap="xs">
        {tasks.map((t) => (
          <Group key={t.label} gap="sm" wrap="nowrap" align="flex-start">
            <ThemeIcon size={22} radius="xl" color={t.done ? "lime.4" : "gray"} variant={t.done ? "filled" : "light"}>
              {t.done ? <IconCheck size={14} /> : <span />}
            </ThemeIcon>
            <div>
              {t.to && !t.done ? (
                <Anchor component={Link} to={t.to}>
                  {t.label}
                </Anchor>
              ) : (
                <Text td={t.done ? "line-through" : undefined} c={t.done ? "dimmed" : undefined}>
                  {t.label}
                </Text>
              )}
              {t.hint && !t.done ? (
                <Text size="sm" c="dimmed">
                  {t.hint}
                </Text>
              ) : null}
            </div>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}
