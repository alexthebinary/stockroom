import { ActionIcon, Button, Group, Popover, Text, TextInput } from "@mantine/core";
import { IconBookmark, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useLocalStore } from "../lib/localStore";

type View = { name: string; values: Record<string, string> };

/**
 * Named filter presets for a list, kept in this browser. Click a view to apply it; "Save view" stores the
 * filters in use right now. `current` holds only the non-empty filters; `apply` replaces them all.
 */
export function SavedViews({ storageKey, current, apply }: { storageKey: string; current: Record<string, string>; apply: (values: Record<string, string>) => void }) {
  const [views, setViews] = useLocalStore<View[]>(`pi.views.${storageKey}`, []);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const hasFilters = Object.keys(current).length > 0;
  const save = () => {
    const n = name.trim();
    if (!n) return;
    setViews([...views.filter((v) => v.name !== n), { name: n, values: current }].slice(-8));
    setName("");
    setNaming(false);
  };
  return (
    <Group gap="xs" className="saved-views" role="group" aria-label="Saved views">
      {views.map((v) => (
        <span key={v.name} className="view-chip" data-active={same(v.values, current) ? "true" : undefined}>
          <button type="button" onClick={() => apply(v.values)}>{v.name}</button>
          <ActionIcon size="xs" variant="subtle" color="gray" aria-label={`Delete view ${v.name}`} onClick={() => setViews(views.filter((x) => x.name !== v.name))}><IconX size={12} /></ActionIcon>
        </span>
      ))}
      <Popover opened={naming} onChange={setNaming} position="bottom-start" withArrow>
        <Popover.Target>
          <Button variant="subtle" size="compact-md" leftSection={<IconBookmark size={16} aria-hidden="true" />} disabled={!hasFilters} onClick={() => setNaming((o) => !o)} title={hasFilters ? undefined : "Set a filter first"}>Save view</Button>
        </Popover.Target>
        <Popover.Dropdown>
          <form onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Text size="sm" mb="xs">Name this view</Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput data-autofocus aria-label="View name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={30} placeholder="For example: Unpaid" />
              <Button type="submit" size="compact-md" disabled={!name.trim()}>Save</Button>
            </Group>
          </form>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
