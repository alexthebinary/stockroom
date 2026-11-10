import { Anchor, Button, Group, Text, TextInput } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../../lib/api";

type Answer = { reply: string; navigate?: { to: string; label: string }; unanswered: boolean };

/** One field on Home: ask how the app works. Common questions answer at once; the rest take a few seconds. */
export function AskHelp() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setError("");
    try {
      setAnswer(await post<Answer>("/help/chat", { messages: [{ role: "user", content: question }], route: "/" }));
    } catch (e) {
      setAnswer(null);
      setError(e instanceof Error ? e.message : "Help is not available right now.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Ask how something works" className="ask-help no-print">
      <form onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <TextInput style={{ flex: 1 }} label="Ask how something works" placeholder="For example: how do I receive a delivery?" leftSection={<IconSparkles size={16} aria-hidden="true" />} value={q} onChange={(e) => setQ(e.currentTarget.value)} maxLength={500} />
          <Button type="submit" variant="default" loading={busy} disabled={!q.trim()}>Ask</Button>
        </Group>
      </form>
      <div role="status" aria-live="polite">
        {answer ? (
          <div className="ask-answer">
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{answer.reply}</Text>
            {answer.navigate ? <Anchor component={Link} to={answer.navigate.to} size="sm" fw={600}>Take me to {answer.navigate.label}</Anchor> : null}
          </div>
        ) : null}
        {error ? <Text size="sm" c="var(--warn-fg)">{error}</Text> : null}
      </div>
    </section>
  );
}
