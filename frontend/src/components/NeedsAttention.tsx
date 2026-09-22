import { Badge, Button, Card, Group, Text } from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import type { AttentionJob } from "../api";
import { money } from "./ui";

/**
 * The work, at the top of the page.
 *
 * The dashboard used to open on five stat tiles — SKUs, on hand, reserved,
 * incoming, stock value. All true, none of them a task. An operator arrives
 * wanting to know what to do, and had to derive it by reading tables.
 *
 * Every row names the thing, says how bad it is, and carries the button that
 * resolves it, so the answer and the action are in the same place.
 */
export function NeedsAttention({ jobs }: { jobs: AttentionJob[] }) {
  if (jobs.length === 0) {
    return (
      <Card withBorder radius="md" p="lg" mb="lg" className="attention-clear">
        <Group gap={10}>
          <IconCircleCheck size={19} stroke={1.8} />
          <div>
            <Text fw={600} size="sm">
              Nothing needs attention
            </Text>
            <Text size="xs" c="dimmed">
              No short orders, no unpaid invoices, nothing below its reorder point.
            </Text>
          </div>
        </Group>
      </Card>
    );
  }

  const urgent = jobs.filter((j) => j.severity === "urgent").length;

  return (
    <Card withBorder radius="md" p={0} mb="lg" className="attention">
      <Group justify="space-between" px="md" py="sm" className="attention-head">
        <Text fw={650} size="sm">
          Needs attention
        </Text>
        <Text size="xs" c="dimmed">
          {jobs.length} item{jobs.length === 1 ? "" : "s"}
          {urgent > 0 && ` · ${urgent} urgent`}
        </Text>
      </Group>

      {jobs.map((job) => (
        <div key={job.id} className="attention-row" data-severity={job.severity}>
          <div className="attention-row-body">
            <Group gap={8} wrap="nowrap">
              <Text component={Link} to={job.to} fw={550} size="sm" className="attention-title">
                {job.title}
              </Text>
              {job.severity === "urgent" && (
                <Badge size="xs" variant="light" color="orange" className="attention-now">
                  now
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {job.detail}
            </Text>
          </div>

          {job.amountCents !== undefined && (
            <Text size="sm" fw={600} className="attention-amount">
              {money(job.amountCents)}
            </Text>
          )}

          {job.action && (
            <Button
              component={Link}
              to={job.action.to}
              size="compact-sm"
              variant={job.severity === "urgent" ? "filled" : "light"}
              className="attention-action"
            >
              {job.action.label}
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}
