import { ActionIcon, Alert, Button, Drawer, Group, Loader, ScrollArea, Stack, Text, Textarea } from "@mantine/core";
import { IconHelp, IconSend } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { get } from "../../lib/api";
import { streamHelp, type HelpMessage, type HelpResult } from "./stream";

type Turn = HelpMessage & { navigate?: HelpResult["navigate"] };
const PAGE_NAMES: Record<string, string> = { "": "Home", receive: "Receive", orders: "Orders", bills: "Bills", payables: "Payables", items: "Items", reports: "Reports", settings: "Settings", guide: "How it works", feedback: "Feedback" };

/** Route context is sent with each question; no company records or page contents are sent. */
export function HelpPanel() {
  const status = useQuery({ queryKey: ["help-status"], queryFn: () => get<{ configured: boolean }>("/help/status"), staleTime: 5 * 60_000 });
  const { pathname } = useLocation();
  const [opened, setOpened] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const page = PAGE_NAMES[pathname.split("/")[1] ?? ""] ?? "this screen";
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, draft, stage, opened]);

  async function send(question = input) {
    const content = question.trim();
    if (!content || inFlight.current) return;
    inFlight.current = true;
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    setInput("");
    setError("");
    setDraft("");
    setStage("Checking the help pages…");
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await streamHelp(history.slice(-6).map(({ role, content: text }) => ({ role, content: text.slice(0, 2000) })), pathname, controller.signal, (event) => {
        if (event.type === "text") setDraft((text) => text + event.text);
        else if (event.type === "status") setStage(event.text);
        else if (event.type === "reset") setDraft("");
      });
      setTurns([...history, { role: "assistant", content: result.reply, navigate: result.navigate }]);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "No connection. Try again when you're online.");
        // Restore the question for retry; a failed request is not a completed turn.
        setTurns(turns);
        setInput(content);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      setDraft("");
      setStage("");
    }
  }
  if (!status.data?.configured) return null;
  return (
    <>
      <ActionIcon variant="subtle" size={44} aria-label="Open help" onClick={() => setOpened(true)}><IconHelp size={23} /></ActionIcon>
      <Drawer opened={opened} onClose={() => setOpened(false)} title="Help" position="right" size="min(100vw, 440px)"
        styles={{ content: { display: "flex", flexDirection: "column", height: "100dvh" }, body: { display: "flex", flex: 1, minHeight: 0, paddingBottom: "max(16px, env(safe-area-inset-bottom))" } }}>
        <Stack style={{ flex: 1, minHeight: 0, minWidth: 0 }} gap="sm">
          <Text size="xs" c="dimmed">On {page}</Text>
          <ScrollArea viewportRef={viewport} style={{ flex: 1, minHeight: 0 }} offsetScrollbars>
            <Stack gap="md" pr="xs" style={{ overflowWrap: "anywhere" }}>
              <Text size="sm" c="dimmed">Ask how ProfitIndex works or where to go. I can explain the steps and offer screen links.</Text>
              {turns.length === 0 ? <Stack gap="xs">
                {["What should I do on this screen?", "How do I receive a delivery?", "Why is stock awaiting a bill?"].map((text) => <Button key={text} variant="default" h="auto" py="xs" styles={{ label: { whiteSpace: "normal", textAlign: "left" } }} onClick={() => void send(text)} disabled={busy}>{text}</Button>)}
              </Stack> : null}
              {turns.map((turn, i) => <Stack key={i} gap="xs" p="sm" style={{ borderTop: "1px solid var(--ink)", background: turn.role === "user" ? "var(--surface-sunken)" : undefined }}>
                <Text size="xs" fw={600} c="dimmed">{turn.role === "user" ? "You" : "Help"}</Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{turn.content}</Text>
                {turn.navigate ? <Button component={Link} to={turn.navigate.to} variant="default" onClick={() => setOpened(false)}>Take me there · {turn.navigate.label}</Button> : null}
              </Stack>)}
              {busy ? <Stack gap="xs" role="status" aria-live="polite">
                {draft ? <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{draft.replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "")}</Text> : <Group gap="xs"><Loader size="xs" color="ink" /><Text size="sm" c="dimmed">{stage}</Text></Group>}
              </Stack> : null}
            </Stack>
          </ScrollArea>
          {error ? <Alert color="red" role="alert">{error}</Alert> : null}
          <Stack gap="xs" pt="sm" style={{ borderTop: "1px solid var(--ink)" }}>
            <Group align="flex-end" wrap="nowrap" gap="xs">
              <Textarea aria-label="Your help question" placeholder="How do I…?" value={input} onChange={(e) => setInput(e.currentTarget.value)} autosize minRows={2} maxRows={4} maxLength={2000} disabled={busy} style={{ flex: 1 }}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
              <ActionIcon aria-label="Send question" size={44} variant="filled" color="lime.4" disabled={busy || !input.trim()} onClick={() => void send()}><IconSend size={20} /></ActionIcon>
            </Group>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Text size="xs" c="dimmed">Unanswered questions are saved to improve help.</Text>
              {turns.length ? <Button variant="subtle" size="compact-xs" disabled={busy} onClick={() => { setTurns([]); setError(""); }}>Start over</Button> : null}
            </Group>
          </Stack>
        </Stack>
      </Drawer>
    </>
  );
}
