import { Button, Group, Loader, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toastErr, toastOk } from "../../components/ui";
import { post } from "../../lib/api";

export type Spec = { problem: string; expected: string; where: string; doneWhen: string[] };
export type ClarifyState = { text: string | null; unavailable?: true; spec: Spec | null; specState: "NONE" | "PROPOSED" | "CONFIRMED"; revision: number; turns: { role: "user" | "assistant"; content: string }[] };

/** A few questions about one note, then a spec card the tester confirms. */
export function ClarifyChat({ noteId, mode = "page", onDone }: { noteId: number; mode?: "compose" | "page"; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ClarifyState | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);

  const call = async (path: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      setState(await post<ClarifyState>(`/feedback/${noteId}/${path}`, body ?? {}));
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
      return true;
    } catch (error) {
      toastErr(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void call("clarify");
  }, [noteId]);

  const answer = async () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    await call("clarify", { message });
  };
  const confirm = async () => {
    if (!state || !(await call("confirm", { revision: state.revision }))) return;
    toastOk(mode === "compose" ? "Thanks, your note was sent" : "Thanks — it's queued to be built");
    onDone();
  };
  const sendAsIs = () => {
    toastOk("Thanks, your note was sent");
    onDone();
  };
  const composeUnavailable = mode === "compose" && state?.unavailable;

  return (
    <Stack gap="sm">
      {(state?.turns ?? []).map((t, i) => (
        <Paper key={i} className={t.role === "user" ? "fb-turn fb-turn-me" : "fb-turn"} p="xs" radius="md">
          <Text size="sm">{t.content}</Text>
        </Paper>
      ))}
      {state?.unavailable ? <Text size="sm" c="dimmed">{mode === "compose" ? "I'll ask you later — your note is saved." : state.text}</Text> : null}
      {busy ? <Loader size="sm" /> : null}
      {state?.spec && state.specState !== "NONE" ? (
        <Paper withBorder p="sm" radius="md" className="fb-spec">
          <Stack gap={4}>
            <Text size="sm"><b>Problem:</b> {state.spec.problem}</Text>
            <Text size="sm"><b>What should happen:</b> {state.spec.expected}</Text>
            <Text size="sm"><b>Where:</b> {state.spec.where}</Text>
            {state.spec.doneWhen.map((d) => <Text key={d} size="sm"><b>Done when:</b> {d}</Text>)}
          </Stack>
          {state.specState === "PROPOSED" ? (
            <Button mt="sm" fullWidth onClick={confirm} loading={busy}>{mode === "compose" ? "Yes, send this" : "Yes, that's what I mean"}</Button>
          ) : (
            <Text mt="sm" size="sm" c="dimmed">Confirmed. It will be built in the next daily run.</Text>
          )}
        </Paper>
      ) : null}
      {!composeUnavailable ? <Textarea placeholder={state?.spec ? "Anything to change?" : "Your answer"} autosize minRows={2} value={text} onChange={(e) => setText(e.currentTarget.value)} disabled={busy} /> : null}
      <Group justify="space-between">
        {mode === "compose" ? (
          <Button variant={composeUnavailable ? "filled" : "subtle"} onClick={sendAsIs} disabled={busy}>Send as is</Button>
        ) : <Button variant="subtle" onClick={onDone}>Later</Button>}
        {!composeUnavailable ? <Button onClick={answer} disabled={!text.trim() || busy}>Reply</Button> : null}
      </Group>
    </Stack>
  );
}
