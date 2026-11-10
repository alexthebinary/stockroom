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
/** Things to do, not just records to find. Shown first, filtered by what is typed. */
const ACTIONS: { title: string; subtitle: string; url: string; words: string }[] = [
  { title: "Receive a delivery", subtitle: "Scan boxes at the dock", url: "/receive", words: "receive delivery scan dock" },
  { title: "New purchase order", subtitle: "Order from a vendor", url: "/orders/new", words: "new purchase order buy" },
  { title: "Stock count", subtitle: "Count stock and post the differences", url: "/stocktake", words: "stocktake count cycle adjust" },
  { title: "Print labels", subtitle: "Pick items on Stock, tick them, print", url: "/items", words: "print labels barcode" },
  { title: "Reorder report", subtitle: "Items at or under their minimum", url: "/reports", words: "reorder low stock minimum replenish" },
  { title: "Bills to review", subtitle: "Accounting inbox", url: "/bills", words: "bills review post invoice" },
  { title: "Payables", subtitle: "What we owe, by vendor", url: "/payables", words: "payables pay owe due overdue" },
  { title: "Reports", subtitle: "Books check, trial balance, stock value", url: "/reports", words: "reports books trial balance journal" },
  { title: "Stock", subtitle: "Items, receipts, adjustments", url: "/items", words: "stock inventory items" },
  { title: "Settings", subtitle: "Team, warehouses, accounts", url: "/settings", words: "settings team warehouses accounts" },
  { title: "How it works", subtitle: "The purchase to stock flow", url: "/guide", words: "guide help how works" },
];
const LABELS = {
  actions: "Go to",
  purchaseOrders: "Purchase orders",
  bills: "Bills",
  vendors: "Vendors",
  items: "Stock",
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
  const actions = useMemo(() => {
    const q = trimmed.toLowerCase();
    const hits = ACTIONS.filter((a) => !q || a.title.toLowerCase().includes(q) || a.words.includes(q));
    return hits.slice(0, q ? 4 : 6).map((a, i): Result => ({ type: "action", id: i, title: a.title, subtitle: a.subtitle, url: a.url }));
  }, [trimmed]);
  const groups = useMemo(() => {
    const found = ready && search.data
      ? (Object.keys(LABELS) as (keyof typeof LABELS)[]).flatMap((key) => search.data[key]?.length ? [{ key, results: search.data[key]! }] : [])
      : [];
    return actions.length ? [{ key: "actions" as const, results: actions }, ...found] : found;
  }, [ready, search.data, actions]);
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
      <Modal opened={opened} onClose={() => setOpened(false)} title="Search or go to" size="lg" yOffset="8dvh" padding="md"
        onEnterTransitionEnd={() => input.current?.focus()}>
        <TextInput ref={input} data-autofocus placeholder="Search records or jump to an action…" aria-label="Search records"
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
          {trimmed.length < 2 ? <Text size="sm" c="dimmed">Pick an action, or type 2 characters to search records.</Text>
            : busy && !actions.length ? <Text size="sm" c="dimmed">Searching…</Text>
            : search.isError ? <Text size="sm" c="red">{search.error.message}</Text>
            : !results.length && !busy ? <Text size="sm" c="dimmed">No results for “{trimmed}”</Text> : null}
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
