import { Center, Group, Table, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconSelector } from "@tabler/icons-react";
import type { ReactNode } from "react";

/**
 * A sortable column heading. The whole heading is the button, so it is
 * reachable by keyboard and has a comfortable pointer target.
 */
export function SortableTh({
  column,
  sort,
  dir,
  onSort,
  align = "left",
  children,
}: {
  column: string;
  sort: string | null;
  dir: "asc" | "desc";
  onSort: (column: string) => void;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const active = sort === column;
  const Icon = active ? (dir === "asc" ? IconChevronUp : IconChevronDown) : IconSelector;

  return (
    <Table.Th p={0}>
      <UnstyledButton
        onClick={() => onSort(column)}
        w="100%"
        px="xs"
        py={8}
        aria-label={`Sort by ${String(children)}`}
      >
        <Group gap={4} wrap="nowrap" justify={align === "right" ? "flex-end" : "flex-start"}>
          <Text size="sm" fw={700} c={active ? "var(--mantine-color-anchor)" : undefined}>
            {children}
          </Text>
          <Center>
            <Icon size={14} stroke={1.8} opacity={active ? 1 : 0.45} />
          </Center>
        </Group>
      </UnstyledButton>
    </Table.Th>
  );
}
