/**
 * The theme contract.
 *
 * 2026-09-22 a dark mode shipped in which the attention-row titles and the
 * wordmark were INVISIBLE — 1.14:1 and 1.16:1. Every contrast ratio sampled
 * by hand before that deploy passed. Two things made that possible, and this
 * file exists to stop both of them recurring:
 *
 *   1. A fixed palette shade cannot flip. 31 call sites used
 *      `var(--mantine-color-gray-N)` directly, so `gray-9` stayed #212529 on
 *      a dark card. Rule 1 below fails on any new one.
 *
 *   2. The light and dark token blocks are maintained by hand, in three
 *      places (the attribute selector, the prefers-color-scheme fallback, and
 *      :root). Nothing kept them in step. Rules 2 and 3 do.
 *
 * ⚠️ WHAT THIS FILE CANNOT DO. It reads CSS text. It does not render, so it
 * cannot see a chip that is the wrong lightness for the page it sits on, an
 * element covered by another, or anything a human would notice by looking.
 * That exact defect — the data-grid status cells — passed every contrast
 * number while being obviously wrong on screen, and was caught by taking a
 * screenshot. This suite is a regression net, NOT a substitute for looking at
 * the page in both modes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const THEME = readFileSync(
  join(__dirname, "..", "..", "frontend", "src", "theme.css"),
  "utf8"
);

/** Strip comments so prose about `gray-9` is not mistaken for a declaration. */
const CODE = THEME.replace(/\/\*[\s\S]*?\*\//g, "");

/** Pull one `--token: value;` out of a block, ignoring comments. */
function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Slice a top-level block by its selector. Brace-counting rather than a regex,
 * because the dark fallback is a rule nested inside a media query.
 */
function block(selector: string): string {
  const start = CODE.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = CODE.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CODE.length; i++) {
    if (CODE[i] === "{") depth++;
    else if (CODE[i] === "}") {
      depth--;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${selector}`);
}

function srgb(v: number) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return (
    0.2126 * srgb((n >> 16) & 255) +
    0.7152 * srgb((n >> 8) & 255) +
    0.0722 * srgb(n & 255)
  );
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const LIGHT = tokensIn(block(":root {"));
const DARK = tokensIn(block(':root[data-mantine-color-scheme="dark"]'));
const FALLBACK = tokensIn(block(':root:not([data-mantine-color-scheme="light"])'));

describe("theme contract", () => {
  it("the contrast helper is calibrated", () => {
    // A check that cannot fail proves nothing; pin the two known extremes.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("declares no fixed Mantine shade outside the dimmed overrides", () => {
    // `--mantine-color-dimmed` is deliberately pinned per scheme: it overrides
    // Mantine's own token and is set to a DIFFERENT shade in each block, which
    // is the correct way to do it. Everything else must be a semantic token.
    const offenders = CODE.split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(
        ({ line }) =>
          /var\(--mantine-color-(gray|dark)-\d\)/.test(line) &&
          !line.startsWith("--mantine-color-dimmed")
      );
    expect(offenders).toEqual([]);
  });

  it("defines every light token in dark, and vice versa", () => {
    // The failure this catches: adding a token to one block only, so it keeps
    // its light value in dark mode and renders invisible.
    const lightOnly = Object.keys(LIGHT).filter(
      (k) => !(k in DARK) && !k.startsWith("--mantine-") && !SCHEME_NEUTRAL.has(k)
    );
    const darkOnly = Object.keys(DARK).filter(
      (k) => !(k in LIGHT) && !k.startsWith("--mantine-")
    );
    expect({ lightOnly, darkOnly }).toEqual({ lightOnly: [], darkOnly: [] });
  });

  it("keeps the prefers-color-scheme fallback in step with the attribute block", () => {
    // These two are duplicated by hand because CSS cannot alias a block. A
    // token updated in one and not the other flashes the wrong value on first
    // paint, which is exactly the kind of drift nobody notices.
    const drift = Object.keys(DARK)
      .filter((k) => k !== "--mantine-color-dimmed" && k !== "--mantine-color-body")
      .filter((k) => FALLBACK[k] !== DARK[k])
      .map((k) => ({ token: k, attribute: DARK[k], fallback: FALLBACK[k] }));
    expect(drift).toEqual([]);
  });

  describe.each([
    ["light", LIGHT],
    ["dark", DARK],
  ])("%s mode meets WCAG AA", (_mode, tokens) => {
    it.each([
      ["--text-strong", "--surface", 4.5],
      ["--text", "--surface", 4.5],
      ["--text-muted", "--surface", 4.5],
      // The faint ramp sits on the SUNKEN plane, not the surface — measuring
      // it against --surface once reported a pass on a token that was failing
      // where it is actually used.
      ["--text-faint", "--surface-sunken", 4.5],
      ["--text-faint", "--surface", 4.5],
      ["--ink", "--surface", 4.5],
      ["--warn-fg", "--surface", 4.5],
      ["--ok-fg", "--surface", 4.5],
      ["--rail-fg", "--rail-bg", 4.5],
      ["--warn-on-rail", "--rail-bg", 4.5],
      ["--on-accent", "--accent", 4.5],
      ["--accent-strong", "--surface", 4.5],
    ])("%s on %s >= %s:1", (fg, bg, floor) => {
      const f = tokens[fg];
      const b = tokens[bg];
      // A missing token must fail loudly; an undefined lookup would otherwise
      // sail through as NaN and report nothing.
      expect(f, `${fg} is not defined`).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(b, `${bg} is not defined`).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(contrast(f, b)).toBeGreaterThanOrEqual(floor);
    });
  });
});

/** Tokens that are legitimately light-only: they carry no colour. */
const SCHEME_NEUTRAL = new Set([
  "--ease-out",
  "--menubar-item-h",
  "--menubar-font",
  "--menubar-gap",
  "--menubar-pad",
  "--menubar-dropdown-item-h",
  "--menubar-dropdown-font",
  "--sidebar-w",
  "--sidebar-w-collapsed",
]);
