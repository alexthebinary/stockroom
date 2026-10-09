import { Badge, Button, Group, SegmentedControl, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCopy, IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, toastErr, toastOk } from "../../components/ui";
import { get, patch } from "../../lib/api";
import { KIND_LABEL, type Note } from "./FeedbackLayer";

const STATUS_LABEL = { OPEN: "Open", DONE: "Done", WONTFIX: "Won't fix" } as const;

/** Every note testers left, with what to do about it, and an export to paste into Claude. */
export function FeedbackPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"OPEN" | "DONE" | "WONTFIX">("OPEN");
  const notes = useQuery({ queryKey: ["feedback", "all", status], queryFn: () => get<Note[]>(`/feedback?status=${status}`) });
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
      <div className="ruled">
        {(notes.data ?? []).length === 0 ? <div className="ruled-empty">No {STATUS_LABEL[status].toLowerCase()} feedback. Testers leave notes from the Feedback tab on the right edge of every screen.</div> : null}
        {(notes.data ?? []).map((note) => (
          <div key={note.id} className="ruled-row" style={{ alignItems: "start" }}>
            <div style={{ minWidth: 0 }}>
              <Group gap="xs" mb={4}>
                <Badge color={note.kind === "BUG" ? "red" : "gray"}>{KIND_LABEL[note.kind]}</Badge>
                <Text size="sm" c="dimmed">
                  #{note.id} · {note.author} · {new Date(note.createdAt).toLocaleString()}
                </Text>
              </Group>
              <Text style={{ whiteSpace: "pre-wrap" }}>{note.note}</Text>
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
    </>
  );
}
