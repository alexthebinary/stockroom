// node probe.mjs <api-base> — runs the live Worker on every note from the API, up to 4 turns each.
// The "tester" answers are scripted per note id from what the developer actually built; unknown ids answer "I'm not sure".
import { readFileSync } from "node:fs";
const envFile = process.env.ENV_FILE ?? new URL("../deploy/.env", import.meta.url);
const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const api = process.argv[2] ?? "http://127.0.0.1:4100";
const ANSWERS = {
  7: ["On Receive, the first screen. I expected to see PO-00002 there.", "It should show the open orders straight away.", "When I open Receive and PO-00002 is listed."],
  1: ["On the new freight bill screen.", "A field to pick which purchase order the freight belongs to.", "When I can choose PO-00002 on a freight bill."],
};
const notes = await (await fetch(`${api}/api/feedback`)).json();
for (const n of notes.sort((a, b) => a.id - b.id)) {
  const note = { kind: n.kind, note: n.note, path: n.path, pageTitle: n.pageTitle, anchorLabel: "", errors: [] };
  const turns = []; let spec = null;
  for (let i = 0; i < 5 && !spec; i++) {
    const r = await fetch(env.CLARIFY_URL, { method: "POST", headers: { authorization: `Bearer ${env.CLARIFY_SECRET}`, "content-type": "application/json" }, body: JSON.stringify({ note, turns }) });
    const raw = await r.text(); let out;
    try { out = JSON.parse(raw); } catch { console.log(`#${n.id} HTTP ${r.status} non-JSON: ${raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`); break; }
    if (out.status !== "ok") { console.log(`#${n.id} ${out.status ?? r.status}`); break; }
    turns.push({ role: "assistant", content: out.text }); spec = out.spec;
    if (!spec) turns.push({ role: "user", content: (ANSWERS[n.id] ?? [])[i] ?? "I'm not sure, you decide." });
  }
  console.log(`\n## #${n.id} ${n.note}\n` + turns.map((t) => `${t.role === "user" ? "Tester" : "AI"}: ${t.content}`).join("\n") + `\nSPEC: ${JSON.stringify(spec)}`);
}
