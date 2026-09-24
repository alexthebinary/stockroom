# ProfitIndex — design

**World: Machine-shop precision.** The app reads like the spec sheet of the machines it sells: every number is a measured figure, every record a datasheet. Mode: Operate (tasks first; brand lives in the details). Direction contract: `.impeccable/surfaces/frontend-src-app-tsx.md`.

## Tokens (frontend/src/theme.css, frontend/src/main.tsx)

| Role | Light | Dark |
|---|---|---|
| Plate (`--surface`) | #fafaf7 | #121311 |
| Rail / sunken | #111210 / #f0f1ec | #0a0b09 / #0c0d0b |
| Ink (`--ink`, primary fill) | #111210 black pill | #eeefe9 inverted pill |
| Signal (`--signal`) | #c6d55a lime | same |
| Passing text (`--ok-fg`) | #3f4a0e olive | #c6d55a |
| Warn | orange ramp (unchanged) | same |

- Mantine palettes: `ink` is primary (shade 7 light / 8 dark). `teal` is remapped to the olive/lime ramp so the 20 existing "done" call sites join the signal family; `blue` is a cool steel for in-transit/info; `dark` is the plate neutrals (Mantine's default #2e2e2e fought the plate).
- **The lime is a signal, never decoration** (target ≤5% of pixels): selection, the active nav tab, the margin dot, the Close "go" bar, finished-state rules. If it spreads, the world collapses.
- Dark-mode filled ink buttons: Mantine hard-wires white labels on the primary; a CSS rule sets `color: var(--on-accent)`.

## Type

Funnel Sans Variable (OFL-1.1, self-hosted via @fontsource). Chosen over Geist (flagged overused by `impeccable detect`) and Host Grotesk (no `tnum`). `font-variant-numeric: tabular-nums` is global. Headings 600, tight tracking; h1 32 / h2 24 / h3 18.

## Components

- **`Stat`** (`components/ui.tsx`) is a ruled spec figure, not a card: 12px tracked caps label, 28px tabular value, 1px ink rule above. Non-numeric values (dates, names) drop to 18px via `data-long`.
- **`SpecStrip`**: the record header's money line (REVENUE · COST · MARGIN on the sales order), 34px figures, hairline dividers, optional `signal` dot on the figure that passed.
- Buttons are pills (`radius: xl` = 999px); plates are 12px. One black pill per record; red is kept only for destructive menu items.
- Links underline with a `--dot` rule; inside tables the underline appears on hover only.

## Motion

150–250 ms state changes on `--ease-out`. **One authored moment:** `.rule-in` draws a 3px lime rule across a finished figure in 480 ms (showroom sale paid, month closed). Off under `prefers-reduced-motion`.

## Contract

`backend/test/theme-contract.test.ts` enforces AA for every text/fill pair in both schemes (now including `--signal-ink` on `--signal`), light/dark token parity, and no fixed Mantine greys. It reads CSS text; it cannot see a render — look at both schemes at 1440 and 390 after any token change.
