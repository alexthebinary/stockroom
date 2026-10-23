import { ApiError, storedProfile } from "../../lib/api";

export type HelpMessage = { role: "user" | "assistant"; content: string };
export type HelpResult = { reply: string; navigate?: { to: string; label: string }; unanswered: boolean; feedbackId?: number };
type Event = { type: "status" | "text"; text: string } | { type: "reset" } | { type: "done"; result: HelpResult } | { type: "error"; error: string };

export async function streamHelp(messages: HelpMessage[], route: string, signal: AbortSignal, onEvent: (event: Event) => void): Promise<HelpResult> {
  const profile = storedProfile();
  const response = await fetch("/api/help/chat/stream", {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...(profile ? { "x-profile": String(profile.id) } : {}) },
    body: JSON.stringify({ messages, route }),
  });
  if (!response.ok) {
    const body = await response.json();
    throw new ApiError(body.error ?? "Help is unavailable. Try again.", response.status);
  }
  if (!response.body) throw new Error("Help did not return a response. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", result: HelpResult | undefined;
  const line = (value: string) => {
    if (!value.trim()) return;
    const event = JSON.parse(value) as Event;
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "done") result = event.result;
    onEvent(event);
  };
  try {
    while (!result) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
    if (buffer.trim()) line(buffer);
    if (!result) throw new Error("The help response was interrupted. Try again.");
    return result;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
