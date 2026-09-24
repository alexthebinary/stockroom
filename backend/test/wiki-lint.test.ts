/**
 * The wiki's "lint" step (Karpathy's LLM Wiki: ingest, query, lint).
 *
 * The assistant answers how-to questions from these pages, so a page that has
 * drifted from the app is a wrong answer delivered confidently. These checks
 * catch the mechanical drift: a link to a page that does not exist, a page the
 * index forgets, and — the one that matters most — a menu destination the wiki
 * never mentions, which is what a new screen looks like the day it ships.
 */
import "./setup";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WIKI_DIR, wikiPages } from "../src/assistant";

const read = (p: string) => fs.readFileSync(path.join(WIKI_DIR, p), "utf8");

describe("wiki lint", () => {
  const pages = wikiPages();
  const index = read("index.md");

  it("has pages, and the index lists exactly those pages", () => {
    expect(pages.length).toBeGreaterThan(5);
    const listed = [...index.matchAll(/^- \[\[([a-z0-9-]+)\]\]/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual(pages);
  });

  it("every [[link]] points at a page that exists", () => {
    const broken: string[] = [];
    for (const p of [...pages.map((x) => `${x}.md`), "index.md"]) {
      for (const m of read(p).matchAll(/\[\[([^\]]+)\]\]/g)) {
        if (!pages.includes(m[1])) broken.push(`${p} → [[${m[1]}]]`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("every menu destination in the app is covered by the index", () => {
    const nav = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/nav.tsx"), "utf8");
    const routes = [...new Set([...nav.matchAll(/to: "(\/[^"]*)"/g)].map((m) => m[1]))];
    expect(routes.length).toBeGreaterThan(10);
    const covered = new Set([...index.matchAll(/\/[a-z/-]*/g)].map((m) => m[0]));
    const missing = routes.filter((r) => !covered.has(r));
    expect(missing, `menu destinations with no wiki page: ${missing.join(", ")}`).toEqual([]);
  });
});
