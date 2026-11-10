import { goTo, type HelpResult } from "./help";
import { HELP_CARDS, type HelpCard } from "./helpCards";

/**
 * Instant help: TypeSafe's Jev reads the question and picks one answer card, returning a typed
 * choice plus a confidence. Jev cannot write text, so it only SELECTS: the answer is the card's
 * pre-written wording. Anything it cannot place (company data, actions, follow-ups, low
 * confidence) returns null and the caller uses the help model as before.
 */
export type JevHelp = (question: string, route: string) => Promise<HelpResult | null>;

const NONE = "none";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Below this confidence the card is not trusted and the help model answers instead. */
export const MIN_CONFIDENCE = 0.8;

type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export function createJevHelp(apiKey: string, fetchImpl: typeof fetch = fetch, cards: HelpCard[] = HELP_CARDS, timeoutMs = 4000): JevHelp {
  const criteria: Record<string, string> = Object.fromEntries(cards.map((card) => [card.id, card.when]));
  criteria[NONE] = "Anything else: the user's own records, counts, balances or totals; a request to do or change something; "
    + "a question the topics above do not cover; small talk; or a message that cannot be understood without earlier conversation.";
  return async (question, route) => {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: "jev-latest",
          state: { question, current_screen: route },
          questions: {
            topic: {
              type: "choice",
              instructions: "Which help topic answers the user's question about how to use the ProfitIndex inventory and purchasing app? current_screen is context only.",
              criteria,
            },
          },
        }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { answers?: { topic?: ChoiceAnswer } };
      const answer = body.answers?.topic;
      if (!answer || answer.type !== "choice" || answer.choice === NONE || answer.confidence < MIN_CONFIDENCE) return null;
      const card = cards.find((c) => c.id === answer.choice);
      if (!card) return null;
      return { reply: card.answer, ...(card.screen ? { navigate: goTo(card.screen) } : {}), unanswered: false };
    } catch {
      return null;
    }
  };
}
