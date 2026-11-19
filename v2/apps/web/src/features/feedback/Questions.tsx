import { Badge, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toastErr, toastOk } from "../../components/ui";
import { get, post } from "../../lib/api";

export type TeamQuestion = {
  id: number;
  text: string;
  context: string | null;
  feedbackIds: number[];
  askedBy: string;
  status: "OPEN" | "ANSWERED" | "WITHDRAWN";
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};

/** "2 hours ago" for a moment. A calendar date once it is older than a month. */
function relativeDate(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function QuestionRow({ question }: { question: TeamQuestion }) {
  const queryClient = useQueryClient();
  const open = question.status === "OPEN";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const showForm = open || editing;

  const send = async () => {
    const answer = draft.trim();
    if (!answer) return;
    setBusy(true);
    try {
      await post(`/questions/${question.id}/answer`, { answer });
      setEditing(false);
      setDraft("");
      toastOk("Answer sent");
      await queryClient.invalidateQueries({ queryKey: ["questions"] });
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ruled-row" style={{ alignItems: "start" }}>
      <div style={{ minWidth: 0 }}>
        <Text style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{question.text}</Text>
        {question.context ? (
          <Text size="sm" c="dimmed" mt={4} style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{question.context}</Text>
        ) : null}
        {question.feedbackIds.length ? (
          <Group gap="xs" mt="xs">
            {question.feedbackIds.map((id) => (
              <Badge key={id} color="gray">#{id}</Badge>
            ))}
          </Group>
        ) : null}
        <Text size="sm" c="dimmed" mt="xs">
          {question.askedBy} · <time dateTime={question.createdAt}>{relativeDate(question.createdAt)}</time>
        </Text>
        {!showForm && question.answer ? (
          <>
            <Text size="sm" mt="sm" p="xs" style={{ whiteSpace: "pre-wrap", lineHeight: 1.4, borderLeft: "3px solid var(--line)", background: "var(--surface-sunken)" }}>
              {question.answer}
            </Text>
            <Group gap="xs" mt="xs">
              <Text size="sm" c="dimmed">
                Answered by {question.answeredBy}
                {question.answeredAt ? <> · <time dateTime={question.answeredAt}>{relativeDate(question.answeredAt)}</time></> : null}
              </Text>
              <Button variant="subtle" onClick={() => { setDraft(question.answer ?? ""); setEditing(true); }}>Edit answer</Button>
            </Group>
          </>
        ) : null}
        {showForm ? (
          <Stack gap="xs" mt="sm">
            <Textarea
              aria-label={editing ? "Edit answer" : "Your answer"}
              placeholder="Your answer"
              autosize
              minRows={2}
              maxLength={4000}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              disabled={busy}
            />
            <Group gap="xs">
              <Button onClick={send} loading={busy}>Send answer</Button>
              {editing ? (
                <Button variant="subtle" onClick={() => { setEditing(false); setDraft(""); }} disabled={busy}>Cancel</Button>
              ) : null}
            </Group>
          </Stack>
        ) : null}
      </div>
    </div>
  );
}

/** Open questions first, then answered. Withdrawn questions stay off this list. */
export function Questions() {
  const questions = useQuery({ queryKey: ["questions"], queryFn: () => get<TeamQuestion[]>("/questions") });
  if (questions.isPending) return null;
  if (questions.isError) return <div className="ruled-empty">Could not load the questions. Try again in a moment.</div>;
  const rows = questions.data ?? [];
  const shown = [...rows.filter((row) => row.status === "OPEN"), ...rows.filter((row) => row.status === "ANSWERED")];
  return (
    <div className="ruled">
      {shown.length === 0 ? <div className="ruled-empty">No questions right now.</div> : null}
      {shown.map((question) => <QuestionRow key={question.id} question={question} />)}
    </div>
  );
}
