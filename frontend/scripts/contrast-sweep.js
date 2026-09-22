/**
 * Contrast sweep — paste into the browser console, or run through a driver.
 *
 * WHY THIS FILE EXISTS. On 2026-09-22 a dark mode shipped with text at 1.14:1
 * because it had been "verified" by sampling a handful of elements by hand.
 * The sweep that found it lived only in a chat transcript, so every fix to the
 * sweep itself was lost the moment the session ended. It is a file now.
 *
 * ── WHAT IT CANNOT DO ────────────────────────────────────────────────────────
 * It compares text against its own background. It therefore CANNOT see:
 *   • a chip, badge or card that is the wrong LIGHTNESS for the page it sits
 *     on. The data-grid status cells passed this sweep while rendering as
 *     near-white blocks on a dark page. Only looking caught that.
 *   • an element covered by, clipped by, or blended with another.
 *   • anything about layout, focus order, or motion.
 * Green here means "no text/background pair fails AA". It does not mean the
 * page is right. Open both modes and look.
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────────
 * Switch scheme the way a USER does, then RELOAD, then sweep. Setting
 * `data-mantine-color-scheme` by hand yields a mixed state — Mantine's JS owns
 * that attribute and its own variables do not follow. That mistake reported
 * 3.20:1 for a label that actually measured 5.38:1.
 *
 *   localStorage.setItem('mantine-color-scheme-value', 'dark');
 *   location.reload();
 *   // ...then paste this file and call:
 *   contrastSweep();
 *
 * Repeat with 'light'. Both must be clean, and `controlCaught` must be true in
 * each — a sweep reporting zero failures may be measuring the sweep.
 */
function contrastSweep({ verbose = false } = {}) {
  /**
   * getComputedStyle does NOT always return `rgb()`. A `color-mix()` resolves
   * to `color(srgb 0.16 0.25 0.59)` — channels 0..1, not 0..255. Scraping
   * numbers blindly read those as near-black and passed every such element
   * trivially: adding one color-mix() to the stylesheet silently blinded this
   * sweep to the very buttons it was added to fix.
   */
  const parse = (c) => {
    const m = c.match(/[\d.]+(?:e[-+]?\d+)?/gi);
    if (!m) throw new Error(`unparseable colour: ${c}`);
    const n = m.map(Number);
    if (/^color\(/i.test(c)) {
      // color(<space> r g b [/ a]) — normalised 0..1.
      if (!/^color\(\s*srgb\b/i.test(c)) {
        throw new Error(`unsupported colour space, cannot compare: ${c}`);
      }
      return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n.length > 3 ? n[3] : 1 };
    }
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };

  const over = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  });

  const lum = (c) => {
    const f = [c.r, c.g, c.b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    // All THREE channels are linearised. A version of this that skipped the
    // blue channel produced eleven impossible failures, including "white on
    // the accent fails AA". Hence the calibration assertion below.
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };

  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };

  /**
   * Composite EVERY translucent ancestor, not just the first painted one.
   * Stopping at the first non-transparent background made a badge on a 15%
   * tint read 1.6:1 when its real value was fine.
   */
  const effectiveBg = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.a > 0) stack.push(c);
      if (c.a === 1) break;
    }
    return stack.reverse().reduce((acc, c) => over(c, acc), { r: 255, g: 255, b: 255, a: 1 });
  };

  /**
   * WCAG 1.4.3 exempts text in an inactive control. Without this the sweep
   * reports every disabled button as a failure — three of them on one page,
   * which is noise a reviewer then has to chase.
   */
  const isDisabled = (el) => {
    const ctrl = el.closest("button, a, input, select, textarea, [role='button'], [data-disabled]");
    if (!ctrl) return false;
    return (
      ctrl.disabled === true ||
      ctrl.getAttribute("aria-disabled") === "true" ||
      ctrl.hasAttribute("data-disabled")
    );
  };

  const sweep = () => {
    const failures = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length || !el.textContent.trim()) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || +s.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (isDisabled(el)) continue;

      const size = parseFloat(s.fontSize);
      const bold = +s.fontWeight >= 700;
      const floor = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const got = ratio(parse(s.color), effectiveBg(el));
      if (got < floor) {
        failures.push({
          text: el.textContent.trim().slice(0, 32),
          selector: (el.className || el.tagName).toString().slice(0, 40),
          ratio: got,
          needs: floor,
        });
      }
    }
    return failures;
  };

  // Calibration: a metric helper must be pinned to a known answer before its
  // output is trusted. This caught a real bug in this very function.
  const calibrated =
    ratio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }) === 21;

  // Control: plant a failure the sweep MUST report, so a clean result means
  // "nothing failed" rather than "nothing was measured".
  const probe = document.createElement("div");
  probe.textContent = "__contrast_control_probe__";
  probe.setAttribute(
    "style",
    "position:fixed;top:0;left:0;z-index:99999;font-size:14px;background:#808080;color:#8a8a8a"
  );
  document.body.appendChild(probe);
  const controlCaught = sweep().some((f) => f.text.includes("__contrast_control_probe__"));
  probe.remove();

  const failures = sweep();
  const result = {
    scheme: document.documentElement.getAttribute("data-mantine-color-scheme"),
    calibrated,
    controlCaught,
    failureCount: failures.length,
    failures,
  };

  if (!calibrated) console.error("CALIBRATION FAILED — the helper is wrong, not the page.");
  if (!controlCaught) console.error("CONTROL NOT CAUGHT — this sweep is measuring nothing.");
  if (verbose || failures.length) console.table(failures);
  return result;
}

if (typeof module !== "undefined") module.exports = { contrastSweep };
