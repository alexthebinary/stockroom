import { Button, Group, Text, Title } from "@mantine/core";
import { IconCheck, IconArrowRight } from "@tabler/icons-react";
import { Link } from "react-router-dom";

export type PathStep = { label: string; why: string; to: string; done: boolean; cta?: string };

/**
 * The first-weeks guide: the steps of this job, in order, with the one next action. It is driven by real
 * data (a step is done when the thing exists), shows the whole path as a strip, and disappears at the end.
 */
export function GuidedPath({ name, intro, steps }: { name: string; intro: string; steps: PathStep[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const next = steps.find((s) => !s.done)!;
  const first = doneCount === 0;
  return (
    <section className="guide-path no-print" aria-label="Getting started">
      {first ? <Title order={2} size="h3">Welcome, {name}</Title> : <Title order={2} size="h3">Next step</Title>}
      <Text c="dimmed" size="sm" maw="62ch">{first ? intro : `${doneCount} of ${steps.length} done.`}</Text>
      <ol className="guide-strip">
        {steps.map((s, i) => (
          <li key={s.label} data-state={s.done ? "done" : s === next ? "next" : "todo"} aria-current={s === next ? "step" : undefined}>
            <span className="guide-dot" aria-hidden="true">{s.done ? <IconCheck size={14} /> : i + 1}</span>
            <span>{s.label}<span className="visually-hidden">{s.done ? " (done)" : s === next ? " (next)" : ""}</span></span>
          </li>
        ))}
      </ol>
      <Group justify="space-between" wrap="wrap" gap="sm" className="guide-next">
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <Text fw={600}>{next.label}</Text>
          <Text size="sm" c="dimmed" maw="62ch">{next.why}</Text>
        </div>
        <Button component={Link} to={next.to} size="md" rightSection={<IconArrowRight size={16} aria-hidden="true" />}>{next.cta ?? "Start"}</Button>
      </Group>
    </section>
  );
}
