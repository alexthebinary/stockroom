import { Badge, Card, Group, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../../components/ui";
import { get } from "../../lib/api";
import type { Item } from "../../lib/types";

type Valuation = { rows: { itemId: number; onHand: number; held: number; valueCents: number; averageCents: number }[] };

/** Find an item: what's on the shelf, what's waiting for a bill, and its codes. */
export function Items() {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 250);
  const items = useQuery({ queryKey: ["items", debounced], queryFn: () => get<Item[]>(`/items${debounced ? `?search=${encodeURIComponent(debounced)}` : ""}`), placeholderData: (prev) => prev });
  const valuation = useQuery({ queryKey: ["valuation"], queryFn: () => get<Valuation>("/reports/valuation") });
  return (
    <>
      <PageHeader title="Items" />
      <TextInput placeholder="Search name, SKU or barcode" value={search} onChange={(e) => setSearch(e.currentTarget.value)} size="md" mb="md" />
      <Stack gap="xs">
        {(items.data ?? []).map((i) => {
          const v = valuation.data?.rows.find((r) => r.itemId === i.id);
          return (
            <Card key={i.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {i.name}
                  </Text>
                  <Text size="sm" c="dimmed" truncate>
                    {i.sku}
                    {i.barcodes?.length ? ` · ${i.barcodes.map((b) => b.raw).join(", ")}` : ""}
                  </Text>
                </div>
                <Group gap="xs" wrap="nowrap">
                  {i.trackingMode === "SERIAL" ? <Badge>Serial</Badge> : null}
                  {i.condition !== "NEW" ? <Badge color="gray">{i.condition.replace("_", " ").toLowerCase()}</Badge> : null}
                  <Stack gap={0} align="flex-end">
                    <Text fw={700}>{v?.onHand ?? 0} on hand</Text>
                    {v?.held ? (
                      <Text size="xs" c="orange">
                        {v.held} awaiting bill
                      </Text>
                    ) : null}
                  </Stack>
                </Group>
              </Group>
            </Card>
          );
        })}
      </Stack>
    </>
  );
}
