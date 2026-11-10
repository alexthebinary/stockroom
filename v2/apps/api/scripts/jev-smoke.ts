import { readFileSync } from "node:fs";
import { createJevHelp, MIN_CONFIDENCE } from "../src/ai/jev";
import { HELP_CARDS } from "../src/ai/helpCards";

// Real-path check of instant help: the key is read from the environment or ~/.config/typesafe/key and never printed.
const key = process.env.TYPESAFE_API_KEY ?? readFileSync(`${process.env.HOME}/.config/typesafe/key`, "utf8").trim();
let lastBody = "";
const spy: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  lastBody = await res.clone().text();
  return res;
};
const jev = createJevHelp(key, spy);

/** expected card id, or null when the question must fall through to the help model */
const cases: [string, string | null][] = [
  ["how do I receive a delivery", "receive_delivery"],
  ["what's the order of purchase order, bill and receipt?", "purchase_flow"],
  ["how do I add a new product", "add_item"],
  ["i need to pay a vendor bill partially", "pay_bill"],
  ["what does awaiting bill mean", "on_hand_vs_awaiting"],
  ["why does the warehouse receipt debit and credit 1200 for the same amount", "warehouse_receipt"],
  ["how do I send stuff back to the supplier", "vendor_credit"],
  ["can I void a posted bill?", "void_bill"],
  ["how do I import a spreadsheet of items", "csv_import"],
  ["how do I switch to another user", "who_working"],
  ["where is the trial balance", "reports_overview"],
  ["what is a bundle", "bundles"],
  ["how many widgets do we have on hand right now", null],
  ["post bill 12 for me", null],
  ["what's the weather today", null],
  ["and what about the second one?", null],
];

let pass = 0;
for (const [question, expected] of cases) {
  const started = Date.now();
  const result = await jev(question, "/");
  const ms = Date.now() - started;
  const answer = (JSON.parse(lastBody) as { answers?: { topic?: { choice?: string; confidence?: number } } }).answers?.topic;
  const got = result ? HELP_CARDS.find((c) => c.answer === result.reply)?.id ?? "?" : null;
  const ok = got === expected;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${ms}ms  jev=${answer?.choice}@${answer?.confidence?.toFixed(2)} used=${got}  expected=${expected}  | ${question}`);
}
console.log(`${pass}/${cases.length} (min confidence ${MIN_CONFIDENCE})`);
