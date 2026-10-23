import assert from "node:assert/strict";
import { chat, createLocalHelpModel } from "../src/ai/help";

// Run against llama-server, rather than a stub: npx tsx scripts/help-smoke.ts
const model = createLocalHelpModel(process.env.LOCAL_LLM ?? "http://127.0.0.1:8080");
const cases = [
  { question: "Why does a warehouse receipt show a debit and a credit on 1200?", terms: [/1200/, /net.{0,15}zero/i, /expected|normal/i], unanswered: false },
  { question: "How do I add a new item?", terms: [/Items/, /Add item/i, /SKU/, /Name/i, /Save/i], unanswered: false },
  { question: "What is our stock value today?", terms: [/Reports/, /stock value/i], unanswered: true },
  { question: "How do I switch the person who is working?", terms: [/avatar|top right/i, /Switch person/i], unanswered: false },
  { question: "How do I receive a serial-tracked item?", terms: [/serial/i, /scan|type/i, /each|every|matching/i], unanswered: false },
  { question: "Which account handles the difference between a vendor return credit and stock cost?", terms: [/6950/, /variance/i], unanswered: false },
  { question: "What is our bank balance right now?", terms: [/don't have that information in the help pages/i], unanswered: true },
];
let failures = 0;
for (const { question, terms, unanswered } of cases) {
  const started = Date.now();
  const result = await chat(model, { messages: [{ role: "user", content: question }], route: "/reports" });
  const elapsed = Date.now() - started;
  console.log(`Q: ${question}\n(${elapsed}ms unanswered=${result.unanswered} nav=${result.navigate?.to ?? "-"})\n${result.reply}\n`);
  try {
    assert(elapsed < 15_000, `Took ${elapsed}ms; limit is 15000ms`);
    assert.equal(result.unanswered, unanswered);
    assert(!result.reply.includes("Screens:"), "Leaked screen map");
    for (const term of terms) assert.match(result.reply, term);
    if (unanswered) assert(!/\$\s*\d|\b\d[\d,.]*\s*(?:USD|dollars)\b/i.test(result.reply), "Invented a balance");
  } catch (error) {
    failures++;
    console.error(String(error));
  }
}
assert.equal(failures, 0, `${failures} smoke cases failed`);
console.log(`PASS: ${cases.length} real-model help cases`);
