import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/** The run journal (runs.jsonl), release manifests and the HALT flag. */
export function createJournal(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const runs = join(stateDir, "runs.jsonl");
  const halt = join(stateDir, "HALT");
  const rows = () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const write = (path, text) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
  return {
    start: (runId) => appendFileSync(runs, JSON.stringify({ runId, phase: "STARTED", at: new Date().toISOString() }) + "\n"),
    finish: (runId, outcome, detail = "") => appendFileSync(runs, JSON.stringify({ runId, phase: "FINISHED", outcome, detail, at: new Date().toISOString() }) + "\n"),
    unfinished: () => { const r = rows(); const done = new Set(r.filter((x) => x.phase === "FINISHED").map((x) => x.runId)); return r.filter((x) => x.phase === "STARTED" && !done.has(x.runId)).map((x) => x.runId); },
    failureStreak: () => { let n = 0; for (const x of rows().filter((x) => x.phase === "FINISHED").reverse()) { if (x.outcome === "NOTHING") continue; if (x.outcome !== "FAILED") break; n++; } return n; },
    writeManifest: (m) => write(join(stateDir, `release-${m.runId}.json`), JSON.stringify(m, null, 1)),
    readManifest: (runId) => { const p = join(stateDir, `release-${runId}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; },
    manifests: () => readdirSync(stateDir).filter((f) => /^release-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(stateDir, f), "utf8"))),
    noteEvent: (runId, ev) => appendFileSync(join(stateDir, `notes-${runId}.jsonl`), JSON.stringify({ ...ev, at: new Date().toISOString() }) + "\n"),
    readNotes: (runId) => { const p = join(stateDir, `notes-${runId}.jsonl`); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; },
    halt: (target, reason) => { write(halt, `${target}\n`); appendFileSync(runs, JSON.stringify({ phase: "HALT", target, reason, at: new Date().toISOString() }) + "\n"); },
    halted: () => (existsSync(halt) ? readFileSync(halt, "utf8").trim() || "*" : null),
    clearHalt: () => rmSync(halt, { force: true }),
  };
}
