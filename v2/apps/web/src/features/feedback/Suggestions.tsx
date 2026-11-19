import { Badge, Button, Group, Select, Stack, Text, Textarea } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toastErr, toastOk } from "../../components/ui";
import { get, patch, post } from "../../lib/api";
import { deviceContext } from "../../lib/diagnostics";
import type { Note } from "./FeedbackLayer";

const AREAS = ["Whole app", "Purchasing", "Sales", "Stock", "Accounting and ledger", "Reports", "People and jobs"];
const STATUS = { OPEN: { label: "Open", color: "blue" }, DONE: { label: "Done", color: "green" }, WONTFIX: { label: "Won't do", color: "gray" } } as const;

/** Suggestions about how the software works as a whole: workflows, rules, structure. Not pinned to a screen, never auto-built. */
export function Suggestions() {
  const queryClient = useQueryClient();
  const all = useQuery({ queryKey: ["feedback", "design"], queryFn: () => get<Note[]>("/feedback") });
  const [area, setArea] = useState<string | null>("Whole app");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = (all.data ?? []).filter((note) => note.kind === "DESIGN").sort((a, b) => Number(b.status === "OPEN") - Number(a.status === "OPEN") || b.id - a.id);

  const send = async () => {
    const note = text.trim();
    if (!note) return;
    setBusy(true);
    try {
      await post("/feedback", { kind: "DESIGN", note, path: "/feedback", pageTitle: area ?? "Whole app", context: deviceContext() });
      setText("");
      toastOk("Suggestion sent");
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (id: number, status: Note["status"]) => {
    try {
      await patch(`/feedback/${id}`, { status });
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
    } catch (error) {
      toastErr(error);
    }
  };

  return (
    <Stack gap="md">
      <Stack gap="xs" maw={720}>
        <Text c="dimmed">
          Suggestions about how the software works as a whole: how a process should flow, an accounting rule, how records relate, what should happen automatically. For a problem on one screen, use the Feedback tab on that screen instead.
        </Text>
        <Select label="Area" data={AREAS} value={area} onChange={setArea} allowDeselect={false} maw={280} />
        <Textarea
          label="Your suggestion"
          placeholder="What works today, what should change, and why. An example from real work helps."
          autosize
          minRows={4}
          maxLength={8000}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          disabled={busy}
        />
        <Group>
          <Button onClick={send} loading={busy} disabled={!text.trim()}>Send suggestion</Button>
        </Group>
      </Stack>
      <div className="ruled">
        {all.isError ? <div className="ruled-empty">Could not load the suggestions. Try again in a moment.</div> : null}
        {all.isSuccess && rows.length === 0 ? <div className="ruled-empty">No suggestions yet.</div> : null}
        {rows.map((note) => (
          <div key={note.id} className="ruled-row" style={{ alignItems: "start" }}>
            <div style={{ minWidth: 0 }}>
              <Group gap="xs" mb={4}>
                <Badge color={STATUS[note.status].color}>{STATUS[note.status].label}</Badge>
                {note.pageTitle ? <Badge color="gray" variant="light">{note.pageTitle}</Badge> : null}
                <Text size="sm" c="dimmed">#{note.id} · {note.author} · {new Date(note.createdAt).toLocaleString()}</Text>
              </Group>
              <Text style={{ whiteSpace: "pre-wrap" }}>{note.note}</Text>
              <Group gap="xs" mt="xs">
                {note.status === "OPEN" ? (
                  <>
                    <Button size="xs" variant="default" onClick={() => setStatus(note.id, "DONE")}>Done</Button>
                    <Button size="xs" variant="subtle" onClick={() => setStatus(note.id, "WONTFIX")}>Won't do</Button>
                  </>
                ) : (
                  <Button size="xs" variant="subtle" onClick={() => setStatus(note.id, "OPEN")}>Reopen</Button>
                )}
              </Group>
            </div>
          </div>
        ))}
      </div>
    </Stack>
  );
}
