# ProfitIndex v2 — design

**Mode: Operate.** People are in a task: a clerk at the dock with a phone and
gloves, an accountant at a desk. The tool should disappear into the task; the
brand lives in precise details. The visual world is carried over from v1
(`../DESIGN.md`, "machine-shop precision"): every number a measured figure,
every record a datasheet.

## Tokens (`apps/web/src/theme.css`, `theme.ts`)

| Role | Light | Dark |
|---|---|---|
| Plate `--surface` | #fafaf7 | #121311 |
| Sunken `--surface-sunken` | #f0f1ec | #0c0d0b |
| Ink `--ink` (primary fill, rules) | #111210 | #eeefe9 |
| Signal `--signal` | #c6d55a | #c6d55a |
| Text `--text-strong / --text / --text-muted` | #111210 / #2b2d28 / #4a4d45 | #eeefe9 / #d9dbd3 / #b0b3a8 |

- Mantine palettes `ink` and `lime` both run light → dark in order, so derived
  hovers are sane (v1's non-monotonic ramps made the black pill hover white).
  `primaryShade` is 9 light / 1 dark — so **anything that fills with the
  signal names `lime.4` explicitly**; plain `lime` would fill dark olive.
- **Lime is a signal, never decoration** (≤5% of pixels): progress, the active
  tab, done ticks, the one "go" action, a tip's marker dot.
- Funnel Sans Variable, tabular numerals everywhere. Selection, caret, focus
  ring and link underlines are themed (`theme.css`, "Browser surfaces").

## Components

- **`Stat`** — a ruled spec figure: tracked caps label, large tabular value, one ink rule.
- **`Ruled` / `RuledRow`** — lists as datasheet rows under one ink rule;
  tappable rows say so on hover. Used instead of stacks of cards.
- **`Coach`** — first-use tips as a quiet sunken aside with a lime dot; gone
  for good after "Got it" (per device).
- **`Checklist`** — "Getting started" per home screen; disappears when done.
- **Kitchen components** (`components/kitchen/`, adapted from dqnamo's
  Kitchen, github.com/dqnamo/website, ISC):
  - `TactileButton` — the clerk's few big actions (Receive, Open scanner,
    Finish). A key with travel reads at a glance with gloves on.
  - `HoldToConfirmButton` — **every action that moves money and can't be
    undone with a tap**: posting a bill, voiding one. Keyboard: hold Enter/Space.
  - `ReceiptPrinter` — finishing a delivery prints the WH-IN receipt. This is
    the clerk flow's **one authored moment**; nothing else animates for show.

## Onboarding (`components/onboarding/`, `features/setup/`)

App Store style: one question per screen, a big title, the action at the
thumb. With sample data it's five screens (welcome, company, you, team, how to
start); starting empty adds warehouse, vendors, items and opening stock.
On a laptop the question sits beside an **ink stage** with a drafting grid,
showing a live picture of what's being built on receipt paper: the
letterhead as you type the company name, "Who's working?" on a phone as people
are added, an item's label as you type its SKU. The finish prints a setup
receipt (the flow's one authored moment). "Who's working?" is a centred grid
of avatar tiles. Choices and roles are real radios (`Choice`, `Chips`).

## Motion

150–250 ms state changes on an exponential ease-out. One authored moment per
flow: the receipt feeding out of the printer (dock), the lime rule drawing
under a settled figure (bill paid). All of it is off under
`prefers-reduced-motion`.

## Process

Design passes follow [impeccable](https://github.com/pbakaus/impeccable)'s
Operate-mode guidance and craft floor: build fully, inspect once in a batch
(phone and desktop, light and dark — the e2e saves these screenshots to
`e2e/screenshots/`), fix everything in one go, confirm once, stop.

## Lists and tables (2026-11-10)

- **One list pattern: `DataTable`** (`components/DataTable.tsx`). Stock, Orders, Bills,
  receipts, adjustments and the Reports held/to-receive lists are one-line-per-row tables
  on wide screens (>= 900 px) and two-line `RuledRow`s on phones. The whole row opens its
  document; the name cell holds the real link or button. Payables and the detail pages use
  Mantine tables, styled to match in `theme.css` (caps tracked headers, ink top rule).
- Status and warning text use `--ok-fg` / `--warn-fg` (and `--ok-bg` / `--warn-bg`); muted
  text is `--text-muted` (also Mantine `dimmed`). Paper and Card sit on `--surface`.
- Motion additions: 160 ms tab-panel fade, Home stat count-up (once), button press dip;
  all off for `prefers-reduced-motion`.
- Touch screens (`pointer: coarse`): buttons, tabs, inputs, links and nav are >= 44 px.
- There is no test sheet page any more.

## Scales and the four-pass audit (2026-11-11)

Measured at 390, 768 and 1440 px on every route, before and after (harness: headless Chromium, read-only).

- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48 (`--space-1..7`). **Type:** 12 / 14 / 16 / 20 / 25 / 31 (`--text-xs..2xl`);
  nothing else renders (13 px and 12.8 px strays removed).
- **Five colours, the rest are tints of them:** plate (`--surface`), ink (`--ink`, `--text-strong`), muted ink
  (`--text-muted`, `--text`), signal lime (`--signal`, `--ok-*`), warning orange (`--warn-*`). Sunken, line and border
  are plate darkened; `-bg` values are the hue at low alpha. Red appears only on the hold-to-void key. No gradients in
  page content (the one exception is the scroll-edge shadow on a wide table).
- **Home (admin)** reads top to bottom by urgency: what needs a person (broken books and late money first, with the
  amount), then money figures (owe, overdue, due in 7 days), then work in hand. Reassurance ("the books are sound") and
  the help field sit in a side column from 1100 px. One ink rule per section; figures inside a section sit on hairlines.
  The page's primary action is in the header.
- **Forms** (`components/form.ts`, `useBlurErrors`): labels above inputs; a field is checked when it is left, never per
  keystroke, and all fields on submit, with focus moved to the first problem. Messages say what to do ("Choose the
  vendor this order goes to."). Submit is not disabled for an incomplete form; it shows `loading` while saving and an
  inline alert that says nothing was saved if the request fails. Number fields have no stepper buttons.
- **Responsive:** under 900 px every Mantine table stacks into cards, one record per block, first column as the title,
  each other value beside its column name (`lib/domPolish.ts` writes `data-label`; rules in `theme.css`). That is the
  same switch point as `DataTable`. Under 900 px, or on any touch screen, every control is at least 44 px; with a mouse,
  at least 24 px. No page scrolls sideways at any of the three widths.
- **Accessibility (WCAG 2.2 AA):** skip link, a named browser tab per page, 2 px ink focus ring on every control
  including text fields, named icon buttons, labelled landmarks, and a global reduced-motion rule (the busy spinner
  still turns). Contrast: no text pair under 4.5:1 in light or dark.
- A calendar day (due date, bill date) is stored as midnight UTC and shown as that day, not the evening before.
