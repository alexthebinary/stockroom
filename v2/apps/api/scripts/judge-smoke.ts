import { readFileSync } from "node:fs";
import { judge, type JudgeDb } from "../src/ai/judge";
import { SAMPLE } from "../src/sample";

// Real-path check of unknown-box matching. The key is read from ~/.config/typesafe/key and never printed.
function loadKey(): string {
  try {
    const key = readFileSync(`${process.env.HOME}/.config/typesafe/key`, "utf8").trim();
    if (key) return key;
  } catch {
    // The file is optional when the environment already has the key.
  }
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  console.error("No TypeSafe key in ~/.config/typesafe/key");
  process.exit(1);
}

const key = loadKey();
let nextId = 0;
const db: JudgeDb = {
  aiJudgment: {
    async create() {
      nextId += 1;
      return { id: nextId };
    },
  },
};

const widget = String(SAMPLE.widget.sku);
const robot = String(SAMPLE.robot.sku);
const openBox = String(SAMPLE.openBox.sku);
const criteria: Record<string, string> = {
  [widget]: `${SAMPLE.widget.name}, ${SAMPLE.widget.sku}`,
  [robot]: `${SAMPLE.robot.name}, ${SAMPLE.robot.sku}`,
  [openBox]: `${SAMPLE.openBox.name}, ${SAMPLE.openBox.sku}`,
};

const cases: { name: string | null; code: string; expected: string }[] = [
  { name: "Sample Widget", code: "869000000001", expected: widget },
  { name: "Sample Robot (serial-tracked)", code: "869000000002", expected: robot },
  { name: "Sample Widget — open box", code: "869000000003", expected: openBox },
  { name: "blue ceramic mug", code: "869000000004", expected: "none" },
  { name: null, code: "SAMPLE-WIDGET", expected: widget },
  { name: "open box widget with a torn carton", code: "869000000006", expected: openBox },
];

let pass = 0;
console.log("expected                got                     band    conf    ms   description");
for (const row of cases) {
  const started = Date.now();
  const result = await judge(
    {
      key: "unknown_item_match",
      subject: `scan:smoke:${row.code}`,
      state: { scanned_code: row.code, description: row.name, quantity: 1, vendor: SAMPLE.supplier.name, purchase_order: "PO-00007" },
      instructions: "Which catalog item is this unknown scanned box? The scanned code may be a barcode, a SKU or a vendor item number. Pick none when none of the candidates is that box.",
      criteria,
      timeoutMs: 8000,
    },
    { fetch, apiKey: key, db },
  );
  const ms = Date.now() - started;
  const got = result?.choice ?? "(no answer)";
  const ok = got === row.expected;
  if (ok) pass += 1;
  const label = row.name ?? `(code ${row.code})`;
  console.log(`${row.expected.padEnd(22)} ${got.padEnd(22)} ${(result?.band ?? "-").padEnd(6)}  ${result ? result.confidence.toFixed(2) : "  -"}   ${String(ms).padStart(5)}  ${label}`);
}
console.log(`${pass}/${cases.length}`);
