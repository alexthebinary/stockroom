import { Alert, Badge, Button, Drawer, Group, SegmentedControl, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertCircle, IconCopy, IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { get, patch } from "../../lib/api";
import { ClarifyChat } from "./ClarifyChat";
import { KIND_LABEL, type Note } from "./FeedbackLayer";

const STATUS_LABEL = { OPEN: "Open", DONE: "Done", WONTFIX: "Won't fix" } as const;

/** Every note testers left, with what to do about it, and an export to paste into Claude. */
export function FeedbackPage() {
  const queryClient = useQueryClient();
  const phone = useMediaQuery("(max-width: 640px)");
  const [chatFor, setChatFor] = useState<number | null>(null);
  const [status, setStatus] = useState<"OPEN" | "DONE" | "WONTFIX">("OPEN");
  const notes = useQuery({ queryKey: ["feedback", "all", status], queryFn: () => get<(Note & { turns?: { role: string; content: string }[] })[]>(`/feedback?status=${status}&turns=1`) });
  const attention = (note: { status: string; autoState: string }) => note.status === "OPEN" && note.autoState === "NEEDS_ANSWER";
  const rows = [...(notes.data ?? [])].sort((a, b) => Number(attention(b)) - Number(attention(a)));
  const waiting = rows.filter(attention);
  const ai = useQuery({ queryKey: ["ai-clarify"], queryFn: () => get<{ clarify: boolean }>("/ai/status") });
  const setNoteStatus = async (id: number, next: Note["status"]) => {
    try {
      await patch(`/feedback/${id}`, { status: next });
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
    } catch (error) {
      toastErr(error);
    }
  };
  const copy = async () => {
    try {
      const markdown = await (await fetch("/api/feedback/export.md")).text();
      await navigator.clipboard.writeText(markdown);
      toastOk("Open feedback copied as Markdown");
    } catch (error) {
      toastErr(error);
    }
  };
  return (
    <>
      <PageHeader
        title="Feedback"
        subtitle="Notes testers pinned in the app. Copy the open ones into Claude to fix them."
        action={
          <Group gap="xs">
            <Button variant="default" leftSection={<IconCopy size={18} />} onClick={copy}>
              Copy open as Markdown
            </Button>
            <Button variant="subtle" leftSection={<IconDownload size={18} />} component="a" href="/api/feedback/export.md" download="feedback.md">
              Download
            </Button>
          </Group>
        }
      />
      <SegmentedControl mb="md" value={status} onChange={(v) => setStatus(v as typeof status)} data={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
      {waiting.length ? (
        <Alert color="red" variant="filled" icon={<IconAlertCircle />} mb="md" title="Needs attention">
          {waiting.length === 1 ? "1 note has" : `${waiting.length} notes have`} a question waiting for an answer: {waiting.map((n) => `#${n.id}`).join(", ")}.
        </Alert>
      ) : null}
      <div className="ruled">
        {rows.length === 0 ? <div className="ruled-empty">No {STATUS_LABEL[status].toLowerCase()} feedback. Testers leave notes from the Feedback tab on the right edge of every screen.</div> : null}
        {rows.map((note) => (
          <div key={note.id} className="ruled-row" style={{ alignItems: "start", ...(attention(note) ? { borderLeft: "4px solid var(--mantine-color-red-6)", paddingLeft: 12 } : {}) }}>
            <div style={{ minWidth: 0 }}>
              <Group gap="xs" mb={4}>
                {attention(note) ? <Badge color="red" variant="filled">Needs attention</Badge> : null}
                <Badge color={note.kind === "BUG" ? "red" : "gray"}>{KIND_LABEL[note.kind]}</Badge>
                <Text size="sm" c="dimmed">
                  #{note.id} · {note.author} · {new Date(note.createdAt).toLocaleString()}
                </Text>
              </Group>
              <Text style={{ whiteSpace: "pre-wrap" }}>{note.note}</Text>
              {attention(note) && note.turns?.at(-1)?.role === "assistant" ? (
                <Text size="sm" mt={6} p="xs" style={{ whiteSpace: "pre-wrap", borderLeft: "3px solid var(--mantine-color-red-6)", background: "var(--surface-sunken)" }}>
                  {note.turns.at(-1)!.content}
                </Text>
              ) : null}
              {ai.data?.clarify && note.status === "OPEN" ? (
                <Button size="xs" variant={attention(note) ? "filled" : "light"} color={attention(note) ? "red" : undefined} my={attention(note) ? 6 : undefined} onClick={() => setChatFor(note.id)}>{note.autoState === "NEEDS_ANSWER" ? "Answer the question" : note.specState === "CONFIRMED" ? "Change the spec" : "Clarify"}</Button>
              ) : null}
              <Text size="xs" c="dimmed">
                {note.specState === "CONFIRMED" ? "Spec confirmed" : note.specState === "PROPOSED" ? "Spec waiting for confirmation" : ""}
                {note.autoState === "SHIPPED" && note.autoCommit ? ` · Shipped in ${note.autoCommit.slice(0, 7)}` : ""}
                {note.autoState === "FAILED" && note.autoNote ? ` · Not built yet: ${note.autoNote}` : ""}
                {note.autoState === "NEEDS_ANSWER" ? " · Waiting for your answer" : ""}
              </Text>
              <Text size="sm" c="dimmed" mt={4}>
                {note.path}
                {note.anchor?.label ? ` · on “${note.anchor.label}”` : ""} · {note.context.viewport ?? "?"} · build {note.context.build ?? "?"}
                {note.context.errors?.length ? ` · ${note.context.errors.length} recent error(s)` : ""}
              </Text>
              <Group gap="xs" mt="xs">
                <Button size="xs" variant="default" component={Link} to={`${note.path}?feedback=${note.id}`}>
                  Open page
                </Button>
                {note.status === "OPEN" ? (
                  <>
                    <Button size="xs" variant="default" onClick={() => setNoteStatus(note.id, "DONE")}>
                      Done
                    </Button>
                    <Button size="xs" variant="subtle" onClick={() => setNoteStatus(note.id, "WONTFIX")}>
                      Won't fix
                    </Button>
                  </>
                ) : (
                  <Button size="xs" variant="subtle" onClick={() => setNoteStatus(note.id, "OPEN")}>
                    Reopen
                  </Button>
                )}
              </Group>
            </div>
            {note.hasScreenshot ? (
              <a href={`/api/feedback/${note.id}/screenshot`} target="_blank" rel="noreferrer">
                <img src={`/api/feedback/${note.id}/screenshot`} alt={`Screenshot for note ${note.id}`} style={{ width: 140, maxHeight: 100, objectFit: "cover", objectPosition: "top", borderRadius: 8, border: "1px solid var(--line)" }} />
              </a>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <Drawer
        opened={chatFor != null}
        onClose={() => setChatFor(null)}
        position={phone ? "bottom" : "right"}
        size={phone ? "auto" : 400}
        title="A few questions about your note"
        overlayProps={{ backgroundOpacity: phone ? 0.3 : 0 }}
        lockScroll={phone}
        zIndex={1002}
        className="fb-ui"
      >
        {chatFor != null ? <ClarifyChat noteId={chatFor} onDone={() => setChatFor(null)} /> : null}
      </Drawer>
    </>
  );
}
