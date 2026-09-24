---
target: menu navigation of the stockroom app
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/alex/Desktop/Projects/inventory-demo/frontend/src/App.tsx"
target_fingerprint: "sha256:b0c6a1dc1f08925e692ea139535fceb68d97f0d39bf1113d665de64170f5b6fc"
target_path: /home/alex/Desktop/Projects/inventory-demo/frontend/src/App.tsx
timestamp: 2026-09-21T17-01-09Z
slug: frontend-src-app-tsx
---
Method: dual-agent (A: design review · B: detector + browser), plus a third non-Anthropic pass (Gemini 3.8 Flash via Antigravity) and parent spot-verification of load-bearing claims.

Note: Assessment B temporarily set a password on backend/prisma/dev.db to complete the browser pass (no documented credential worked). Backed up and restored, md5-verified identical.

# Stockroom navigation — design critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Sub-rail highlights nothing on any detail page. Browser-confirmed at /products/131: 6 inactive links, underline scaleX(0) |
| 2 | Match System / Real World | 2 | "Home" opens a page titled Dashboard; "Accounting" is one ledger; "Managers" is /catalogs/employees; "Stock on hand" names two different pages |
| 3 | User Control and Freedom | 2 | No skip link, no breadcrumb, no global search, 404 is a dead end, mobile drawer has no scrim and ignores Escape |
| 4 | Consistency and Standards | 2 | Four nav surfaces, three active-state mechanisms, and they disagree. Inventory is the one section whose landing page is not its first sub-item |
| 5 | Error Prevention | 1 | All four roles see all 18 destinations. Permission boundaries discoverable only by hitting a 403 |
| 6 | Recognition Rather Than Recall | 2 | 173px of the Inventory sub-rail (3 of 6 items) off-screen at 390px with ScrollArea type="never" and no affordance |
| 7 | Flexibility and Efficiency | 1 | Zero shortcuts, zero search, no palette, no recents |
| 8 | Aesthetic and Minimalist Design | 3 | Well-tokenised; every nav contrast pair passes; prefers-reduced-motion fully honored. Cost is 148.3px (22.2%) of permanent phone chrome and 7 sections at identical weight |
| 9 | Error Recovery | 1 | 404 renders bare Text, header collapses 44px, no link out. LedgerHealth returns null on query failure as well as on health |
| 10 | Help and Documentation | 2 | About.tsx is 586 substantial lines, buried as Settings' 4th item, unreachable from the phone |
| **Total** | | **18/40** | **Needs work** |

All ten heuristics applied; none n/a.

## Design Specificity Verdict

Authored shell, template information architecture. The split is the finding.

Authored: two-row structure with a written argument against hover menus (App.tsx:39-49); Receive placed ahead of the section's own landing page; PHONE_SECTIONS cutting the bottom bar to four; a print stylesheet that strips chrome; GatedButton keeping disabled actions focusable; a dark-rail-specific focus ring.

Template: the map. SECTIONS is a module-level constant blind to role, frequency, and identifier lookup — the three facts that define this product.

Deterministic scan: detector exit 0, zero findings on App.tsx, components/, pages/, theme.css and the whole frontend/src tree. Null validated against the engine's own fixtures (12 and 7 findings, exit 2). Static detector has no accessibility rules.

Live overlay (injection succeeded, no CSP): 34 findings at 390x844, 30 at 1440x900. False positives: 3x text-occlusion (overlay flagging its own labels), gray-on-color on .wordmark (hex-pattern match against a real 13.09:1).

## What's Working

1. Sub-rail is persistent, not hover-triggered, and renders on mobile. The usual failure of this pattern is unreachable inner pages; the header math RAIL_H + SUB_H accounts for the second row.
2. Contrast and motion are right across the whole nav. Rail text 13.09:1, inactive 7.55:1, sub-rail active 5.64:1, focus ring 8.43:1. Under prefers-reduced-motion: reduce every nav transition collapses to 1e-05s including Mantine's own AppShell transforms (theme.css:411).
3. Disabled actions stay focusable and explain themselves. GatedButton uses data-disabled so the control keeps its tab stop. Only let down by never covering the role case.

## Priority Issues

### [P0] Mobile Receive scanner button sits under the bottom bar
Receive.tsx:191 pins the primary action position: fixed; bottom: 0 with no z-index. .bottom-bar (theme.css:281-286) is z-index: 200 and renders after AppShell.Main. .has-bottom-bar padding moves flow content, not a fixed box. 80px container against a measured 52.3px bar leaves ~15px of a 56px button.
Why: camera receiving is the flagship feature, this is its only action, on the device it was built for.
Fix: z-index: 201 and bottom: calc(52px + env(safe-area-inset-bottom)), or hide the bottom bar on /receive and let the dock own the thumb zone.
Confidence: verified by code + CSS measurement, NOT by browser capture — B did not visit /receive at phone width.
Command: /impeccable adapt

### [P1] Nav is role-blind while the server is not
backend/src/auth.ts:33-36 defines stock/money/users capabilities enforced across ten route modules. App.tsx reads three fields from useAuth(), none a capability; grep for can.stock / can.money in frontend/src returns nothing. WAREHOUSE is offered Accounting, Reports->Valuation, Settings->Posting rules. FINANCE is offered camera receiving. VIEWER is offered all eighteen. GatedButton reasons are computed from order status only.
Fix: add needs?: keyof Capabilities to Section and items, filter once at render, make capability the first condition in GatedButton's reason chain. Leave read-only destinations visible. Guard LedgerHealth with can.money.
Command: /impeccable harden

### [P1] `end` on the sub-rail kills the highlight exactly where work happens
App.tsx:307 and :341. Exact match, so /products/42, /sales-orders/5, /purchase-orders/9, /warehouses/2 render all-gray. Browser-confirmed at 1440 and 390. sectionFor() already does the prefix work at App.tsx:126, so the sub-rail is less accurate than the resolution it derives from.
Fix: drop `end` from both. No sub-item path is a prefix of another at a / boundary — verified across all 18 destinations.
Command: /impeccable harden

### [P1] Two independent a11y structure failures, both invisible in review
aria-current on the rail is a no-op: react-router-dom/dist/index.js:204 destructures "aria-current" into excluded props and re-emits at :865 from NavLink's own isActive. SectionButton:145 passes it; it never reaches the DOM. Browser-confirmed: /inventory has 5 aria-current="page", /products/131 has zero.
Collapsed drawer stays in the tab order: Mantine collapses via transform: translateX(-260px) only — display: flex, visibility: visible, not inert, not aria-hidden. Tab lands on 7 invisible links at x=-248, stops 9-15, on desktop where the drawer can never open.
Fix: use Link not NavLink for the rail, set data-active and aria-current from s === section. Add inert to the collapsed navbar. Add a skip link (up to 15 tab stops before content).
Command: /impeccable audit

### [P2] Sub-rail overflow invisible on a phone
Measured scrollWidth 553 vs clientWidth 380 at 390px: 173px, three of six items, hidden. ScrollArea type="never" renders no scrollbar in any state. No fade, chevron or peek. The sub-rail is the only path to those pages on a phone (bottom bar carries 4 of 7 sections; drawer expands only the current section). Adjustments is among the hidden three.
Fix: type="auto" plus a right-edge mask-image gradient.
Command: /impeccable adapt

### [P2] No menu entry for three shipped capabilities
Shipped backend with zero UI: (a) POST /sales-orders/shipments/:id/tracking, GET /shipping-carriers, trackingUrl() in carriers.ts — api.ts:309 types shipments without carrier/trackingNumber/deliveredAt; (b) GET/POST /users, PATCH /users/:id behind requireUsers with last-admin lockout — no page, and nav's "Managers" points at the unrelated Employee table; (c) stockCountsRouter, repair/RMA, serial intake — grep -rn "repair" frontend/src hits only About.tsx.
Also: invoices and shipments exist only nested inside one sales order. "Which invoices are unpaid" and "what is in transit" require opening orders one at a time.
Invoicing/manual-sales request specifically: already complete (POST /sales-orders defaults channel DIRECT, invoice verb posts to the ledger, pdf.ts renders a real document with a VOID watermark). Delivery tracking is the only missing half and only in the UI. (1) widen the shipments type in api.ts; (2) compute trackingUrl server-side in the GET /sales-orders/:id mapper — POST returns it, GET does not; (3) add carrier select + tracking input + Mark delivered to the shipment row on SalesOrderDetail; (4) add Invoices and Deliveries as Sales sub-items (2 -> 4; Inventory at 6 is the one over budget).
Command: /impeccable shape

## Persona Red Flags

Impatient power user (200+ receipts/shift): no search, palette or shortcuts — zero hits for spotlight/cmdk/useHotkeys. SKU lookup is five interactions. /receive is four from the front door and absent from the bottom bar. Tapping "Inventory" lands on Stock on hand, not Receive — the only section where the landing page is not the first sub-item. No breadcrumb back to a list after shipping.

Accessibility-dependent user: no skip link, up to 15 tab stops before content. Seven offscreen drawer links in the desktop tab order. aria-current absent on 10 of 18 destinations. Drawer has no focus trap, no focus restoration, no scrim; Escape leaves it at x=0. Drawer nav has no aria-label while sub-rail and bottom bar both do.

Distracted mobile user: the P0 scanner occlusion. Three nav systems visible at once when the drawer is open, with Inventory and Stock on hand in all three. Open drawer is full-width (--app-shell-navbar-width: 100% below breakpoint) with no outside region to tap. Sign-in hangs ~30s on cold Render start after prefilling a credential that works in neither database.

## Minor Observations

- sectionFor() is currently correct for all 18 routes including detail pages. Ordering hazard is latent: pass 2 treats Settings.to = "/catalogs/categories" as a namespace when it is a leaf. A future sixth catalog tab renders with the whole second row gone. Fix: add match?: string to Section, set Settings' to /catalogs.
- The one real contrast defect is not in the nav and is an inert fix. theme.css:33 overrides --mantine-color-dimmed to gray-7 under a comment correctly noting gray-6 is 3.32:1. Mantine declares it at styles.css:475 under :root[data-mantine-color-scheme='light'] (0,2,0) vs theme.css plain :root (0,1,0). Import order irrelevant. Runtime value #868e96; live detector found 19 elements at 3.1-3.3:1. Intended 8.18:1. Separately, reorder-point orange #f76707 measures 3.04:1 (4 instances).
- Touch targets: .bottom-link 95x52.3 and .subrail-link 44 tall pass. .rail-link 34.3, .rail-account 36.8, .drawer-link 39.7, Burger 28x28 fail WCAG 2.5.5 AAA; all clear 2.5.8 AA (24x24). Only the burger is phone-only.
- .has-bottom-bar reserves 62px against a measured 52.3px bar. Over-reserves 9.7px, no occlusion (10.1px clearance at max scroll), but a hardcoded constant that would not track a wrapped label or scaled font.
- Drawer focus rings use the wrong token: .rail :focus-visible yields #9dc2ff, drawer links get Mantine's #4263eb. Both visible.
- Header height mutates on navigation (App.tsx:235). Home, Accounting and 404 have no second row; every cross-section move jerks the page 44px.
- LedgerHealth has margin-left: auto AND sits in a justify="space-between" Group. When absent (the normal case) the account button jumps. Below sm the label is hidden with no aria-label, so it announces as an empty link.
- Nav label != page H1 in five places: Home->Dashboard, Stock on hand->Inventory, Adjustments->Stock adjustments, Transfers->Stock transfers, Managers->a panel over /employees.
- Print CSS hides .rail and .subrail but not .acting-banner — an admin working-as-warehouse prints an amber banner onto a valuation report going to an auditor.
- Login hint still poisoned: Login.tsx:9-10,58 prefills demo@user.com / password. B confirmed the DB holds exactly one user, admin@user.com; the seed's five role accounts were never created. HANDOFF.md:18 flags this in red as having cost a day.

## Position on shape

Desktop: keep the two rows. 96px of 900 is 11%, destinations never move so position becomes muscle memory, position: fixed costs nothing on scroll. At 7 sections and 18 destinations a flat visible map beats a drill-down. A left-rail rebuild trades a real 44px layout shift for a rewrite of every page's width assumptions; the shift is cheaper to fix directly.

Phone: break it. 148.3px of 667 is 22.2% before the page's own header. Promote Receive into PHONE_SECTIONS, collapse the sub-rail on scroll-down, fix the P0.

Both: add a command palette. Highest-leverage change available and independent of every structural argument. Primary nouns are SKUs, serials, PO and SO numbers — identifiers the operator is physically holding. Today reaching one is five interactions. Only fix that still works when invoices, deliveries, users, stock counts and repairs become destinations 19-23.

## Questions to Consider

- auth.ts distinguishes stock-work from money-work in a comment that reads like the product's thesis. Why has the navigation never consulted it?
- The SECTIONS comment argues from frequency but no frequency was measured, and Receive and Posting Rules ended up at the same depth.
- Is the top rail a navigation or a table of contents? What would it say if it could carry counts?
- If a palette shipped tomorrow, what would remain of the case for two permanent rows?
- The Books badge renders nothing when sound and nothing when the check fails. Indicator or decoration?
