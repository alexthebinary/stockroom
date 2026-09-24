---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

# Surface brief: ProfitIndex app shell (all Operate screens)

Scope: the whole authenticated app — Home, Showroom sale, Receive, orders, bills, Month-end close, assistant. Mode: Operate.
Audience: warehouse clerk on a phone at the dock; owner/accountant on a desktop.
Constraints: AA contrast in light and dark (theme-contract test), 44px phone targets, Mantine component vocabulary kept (earned familiarity).

## Direction contract
THESIS: ProfitIndex reads like the spec sheet of the machines it sells — every number is a measured figure, every record a datasheet.
WORLD: Machine-shop precision. Near-white plate grounds, a second cooler neutral for rails, black ink, black pill actions, one acid-lime signal (#C6D55A) reserved for go/selected/passing. Geist, set tight; tabular figures everywhere money or stock appears.
FIRST VIEWPORT: Home opens on the work list with figures set as spec values (label above, large tabular number below, hairline rules between), not stat cards.
SIGNATURE: Record headers as datasheets — the order/PO header is a ruled spec strip (REVENUE · COST · MARGIN) with the primary action as the one black pill.
MOTION: 160–200ms ease-out state changes only; one authored moment: the paid/closed confirmation drawing its rule and figure in.
RISK: familiarity — lime must stay a signal (≤5% of pixels); if it spreads to decoration the world collapses into a template.
Seed: 3a477130 (pick card chosen by the operator over the dealt direction).
