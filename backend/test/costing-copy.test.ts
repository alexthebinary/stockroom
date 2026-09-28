/**
 * Nothing still says FIFO (weighted average since 2026-09-28).
 *
 * The assistant answers from backend/wiki and quotes screen copy, so one stale
 * "valued at FIFO" sentence becomes a confident wrong answer about the books.
 * The only allowed mentions name the cutover itself.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "wiki", "../frontend/src"].map((r) => path.resolve(__dirname, "..", r));
/** Lines that describe the switch away from FIFO are history, not claims. */
const ALLOWED = /replaced FIFO|FIFO → average|FIFO cutover|was fifo|Under FIFO|FIFO would/i;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|md)$/.test(e.name) ? [p] : [];
  });
}

describe("costing copy", () => {
  it("no source, wiki page or screen claims FIFO costing", () => {
    const hits: string[] = [];
    for (const f of ROOTS.flatMap(files)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/\bFIFO\b/i.test(line) && !ALLOWED.test(line)) {
          hits.push(`${path.relative(path.resolve(__dirname, "../.."), f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
