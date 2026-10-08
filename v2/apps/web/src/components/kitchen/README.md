# Kitchen components

Adapted from dqnamo's Kitchen (https://www.dqnamo.com/kitchen, source
github.com/dqnamo/website, ISC per its package.json): `TactileButton`,
`HoldToConfirmButton` and `ReceiptPrinter`. Ported from Tailwind + motion to
plain CSS on ProfitIndex's tokens (`theme.css`, section "Kitchen"), so they
carry the machine-shop palette and work in both colour schemes.

Where each one earns its place:

- **TactileButton** — the clerk's few big actions (Receive, Open scanner,
  Finish delivery). A physical, compressible key reads at a glance with a
  glove on and confirms the press with travel, not just colour.
- **HoldToConfirmButton** — the actions that move money and can't be taken
  back with a tap: posting a bill, voiding one. The fill shows the hold;
  keyboard users hold Enter or Space.
- **ReceiptPrinter** — when a delivery is finished it prints the WH-IN
  warehouse receipt the WMS workflow calls for: the one authored moment in the
  clerk's flow.
