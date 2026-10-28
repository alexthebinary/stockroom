import { Box, Button, Group, Loader, Modal, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get } from "../lib/api";
import { useProfile } from "../lib/profile";

type Result = { type: string; id: number; title: string; subtitle: string; url: string };
type Results = Partial<Record<keyof typeof LABELS, Result[]>>;
const LABELS = {
  purchaseOrders: "Purchase orders",
  bills: "Bills",
  vendors: "Vendors",
  items: "Inventory",
  journalEntries: "Journal entries",
  credits: "Vendor credits",
  payments: "Payments",
};

export function GlobalSearch() {
  const { profile } = useProfile();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const trimmed = query.trim();
  const [debounced] = useDebouncedValue(trimmed, 200);
  const ready = opened && trimmed.length >= 2 && trimmed === debounced;
  const search = useQuery({
    queryKey: ["global-search", profile?.id, debounced],
    queryFn: () => get<Results>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: ready,
    retry: false,
  });
  const groups = useMemo(() => ready && search.data
    ? (Object.keys(LABELS) as (keyof typeof LABELS)[]).flatMap((key) => search.data[key]?.length ? [{ key, results: search.data[key]! }] : [])
    : [], [ready, search.data]);
  const results = useMemo(() => groups.flatMap((group) => group.results), [groups]);
  const busy = trimmed.length >= 2 && (!ready || search.isFetching);
  const open = () => {
    setQuery("");
    setSelected(0);
    setOpened(true);
  };
  const choose = (result: Result) => {
    setOpened(false);
    navigate(result.url);
  };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Let an existing editor, feedback dialog, or other modal own its keys.
      if (!opened && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const typing = target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"]');
      const commandK = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !typing;
      if (!commandK && !slash) return;
      event.preventDefault();
      if (opened) input.current?.focus();
      else open();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [opened]);

  useEffect(() => setSelected(0), [trimmed, search.data]);
  useEffect(() => {
    if (opened) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [opened, selected, listId, results]);

  return (
    <>
      <Button variant="subtle" onClick={open} aria-label="Search" style={{ height: 44, minWidth: 44, paddingInline: 10 }}>
        <Group gap={6} wrap="nowrap">
          <IconSearch size={20} />
          <Text component="span" size="sm" visibleFrom="sm">Search</Text>
        </Group>
      </Button>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Search ProfitIndex" size="lg" yOffset="8dvh" padding="md"
        onEnterTransitionEnd={() => input.current?.focus()}>
        <TextInput ref={input} data-autofocus placeholder="Search orders, inventory and more…" aria-label="Search records"
          leftSection={<IconSearch size={18} />} rightSection={busy ? <Loader size="xs" /> : undefined}
          value={query} onChange={(event) => setQuery(event.currentTarget.value)}
          role="combobox" aria-expanded={results.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
              event.preventDefault();
              setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
            } else if (event.key === "Enter" && results[selected] && !busy) {
              event.preventDefault();
              choose(results[selected]);
            }
          }} />
        <Box mt="sm" role="status" aria-live="polite">
          {trimmed.length < 2 ? <Text size="sm" c="dimmed">Type at least 2 characters to search.</Text>
            : busy ? <Text size="sm" c="dimmed">Searching…</Text>
            : search.isError ? <Text size="sm" c="red">{search.error.message}</Text>
            : !results.length ? <Text size="sm" c="dimmed">No results for “{trimmed}”</Text> : null}
        </Box>
        <Box id={listId} role="listbox" aria-label="Search results" aria-busy={busy} style={{ maxHeight: "55dvh", overflowY: "auto" }}>
          {groups.map((group) => (
            <Box key={group.key} role="group" aria-labelledby={`${listId}-${group.key}`} mt="sm">
              <Text id={`${listId}-${group.key}`} size="xs" fw={700} c="dimmed" px="sm" mb={4}>{LABELS[group.key]}</Text>
              <Stack gap={2}>
                {group.results.map((result) => {
                  const index = results.indexOf(result);
                  return <UnstyledButton key={`${result.type}-${result.id}`} id={`${listId}-${index}`} role="option" aria-selected={selected === index}
                    tabIndex={-1} onMouseEnter={() => setSelected(index)} onClick={() => choose(result)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: selected === index ? "var(--mantine-color-default-hover)" : undefined }}>
                    <Text size="sm" fw={600} truncate>{result.title}</Text>
                    <Text size="xs" c="dimmed" truncate>{result.subtitle}</Text>
                  </UnstyledButton>;
                })}
              </Stack>
            </Box>
          ))}
        </Box>
        <Text size="xs" c="dimmed" mt="sm">↑ ↓ to select · Enter to open · Esc to close</Text>
      </Modal>
    </>
  );
}
