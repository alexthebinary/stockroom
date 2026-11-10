import { describe, expect, it } from "vitest";
import { HELP_CARDS } from "../src/ai/helpCards";
import { createJevHelp, MIN_CONFIDENCE } from "../src/ai/jev";
import { SCREENS } from "../src/ai/help";

const answering = (choice: string, confidence: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ model: "jev-1", answers: { topic: { type: "choice", choice, confidence, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as typeof fetch;

describe("instant help cards", () => {
  it("every card has a unique id, a short plain answer and a real screen", () => {
    expect(new Set(HELP_CARDS.map((c) => c.id)).size).toBe(HELP_CARDS.length);
    for (const card of HELP_CARDS) {
      expect(card.answer.length).toBeLessThan(420);
      expect(card.answer).not.toMatch(/[*#`]/);
      if (card.screen) expect(Object.keys(SCREENS)).toContain(card.screen);
    }
  });
  it("returns the chosen card's answer and screen link", async () => {
    const jev = createJevHelp("k", answering("pay_bill", 0.95));
    const result = await jev("how do I pay a bill", "/");
    expect(result?.reply).toBe(HELP_CARDS.find((c) => c.id === "pay_bill")!.answer);
    expect(result?.navigate?.to).toBe("/payables");
    expect(result?.unanswered).toBe(false);
  });
  it("falls through on none, low confidence, an unknown card, an HTTP error and a network failure", async () => {
    expect(await createJevHelp("k", answering("none", 0.99))("q", "/")).toBeNull();
    expect(await createJevHelp("k", answering("pay_bill", MIN_CONFIDENCE - 0.01))("q", "/")).toBeNull();
    expect(await createJevHelp("k", answering("made_up", 0.99))("q", "/")).toBeNull();
    expect(await createJevHelp("k", (async () => new Response("no", { status: 500 })) as typeof fetch)("q", "/")).toBeNull();
    expect(await createJevHelp("k", (async () => { throw new Error("offline"); }) as typeof fetch)("q", "/")).toBeNull();
  });
});
