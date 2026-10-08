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
