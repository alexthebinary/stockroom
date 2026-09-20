# Warehouse beta — runbook

Prepared 2026-09-19. Nothing here has been deployed; commit `16f912a` is local only.

## Decisions taken

| Question | Decision |
|---|---|
| Hosting | Free Render tier for now, **accepting** ~30s cold starts and the Postgres expiry |
| Deploy | **Held** — code stays on this machine until explicitly released |
| Vision | **One** model to start (`VISION_A` only) |

## 🔴 Two dates and one behaviour the warehouse will feel

1. **The Postgres instance expires ~2026-10-10.** That is roughly three weeks out.
   Real receiving data entered during the beta disappears with it. Either the beta
   finishes before then, or the database is migrated first. This is not a warning
   that can be deferred twice.
2. **The service sleeps after ~15 minutes idle**, then takes ~30s to wake. The
   first scan of the morning, and the first after any lull, will hang. Tell the
   clerk this is expected, or the beta reads as "the app is broken".
3. **Every deploy logs everyone out** while `AUTH_SECRET` is unset. Do not deploy
   during a shift.

Mitigation that costs nothing: hit `https://stockroom-axlo.onrender.com/api/health`
on a timer (any free uptime pinger, 10-minute interval) during warehouse hours.
That keeps the instance awake and removes the cold start entirely.

## Release, when you are ready

```bash
cd ~/Desktop/Projects/inventory-demo
git push origin master

# ⚠️ Auto-deploy is configured but NOT wired — the service was created via the
# API, so no GitHub webhook exists and pushing alone deploys nothing.
curl -X POST \
  -H "Authorization: Bearer $(cat ~/.config/render/api-key)" \
  https://api.render.com/v1/services/srv-dahgg0u7bikc73fq5j2g/deploys
```

Then confirm, in this order:

```bash
curl -s https://stockroom-axlo.onrender.com/api/health          # {"ok":true}
curl -s .../api/shopify/status                                   # mode must read "sim"
curl -s .../api/receiving/capabilities                           # visionReaders: 1
```

The schema arrives via `db push` on the Postgres path (`backend/docker-entrypoint.sh:15`),
because SQLite migration history cannot apply to Postgres. All eight new tables are
additive and `Product.trackingMode` defaults to `NONE`, so existing rows are untouched.

## Environment

```bash
# Vision — ONE reader for the beta.
VISION_A_URL=https://<openai-compatible-endpoint>/v1/chat/completions
VISION_A_KEY=<key>
VISION_A_MODEL=<vision-model>
VISION_A_FAMILY=<family>        # e.g. "deepseek". Defaults to the model name.

# Shopify — deliberately absent. Without SHOPIFY_MODE=live the app runs the
# simulator, and credentials alone are NOT treated as consent to write to a
# real store.

# Fixes the logout-on-every-deploy problem. Any long random string.
AUTH_SECRET=<32+ random chars>
```

⚠️ **Consequence of one vision model, stated plainly.** Agreement is counted by
model *family*, so a single reader can never corroborate itself — **every OCR-only
scan will be committed and flagged**. The unit is in stock and usable immediately;
it simply also appears in `GET /api/receiving/attention`. Expect that feed to fill
in proportion to how many boxes lack a scannable barcode. If it fills faster than
anyone drains it, that is the signal to add `VISION_B`, not a fault.

Boxes **with** a barcode bypass this entirely: `BarcodeDetector` runs in the
browser, outranks OCR, and commits unflagged on its own.

## What the clerk does

1. Open the app on a phone, sign in.
2. **Receive** → pick the warehouse → tap the arriving PO line.
3. **Open scanner** → aim at the label → **Scan**. The viewfinder stays open;
   keep scanning box after box. A buzz and a green line mean it booked.
4. Amber means it booked *and* wants an eye on it later. Keep going.
5. Grey means try another angle — it asks twice before it asks a person.

Camera requires HTTPS. Render provides it; `localhost` also works for testing.

## Known gaps, honestly

- **The camera path has no automated test.** `getUserMedia` needs a real device.
  It is the only part of this build with nothing behind it — exercise it on the
  actual phone before the first real delivery.
- **Product ↔ Shopify variant links are seeded by hand.** No UI yet.
- **Nothing triggers the Shopify push automatically.** Receiving books stock; a
  separate call publishes it.
- **Serial patterns for Unitree / BambuLab / XAG are unverified guesses.** They
  drive auto-correction of OCR misreads, so a wrong pattern turns a good read
  into a confident bad one. Check them against real labels first — it is a
  five-minute job with a handful of boxes and the highest-value check remaining.
- **The 400-vs-409 race response** in `costing.ts` is documented and undecided:
  a picker who loses a concurrent race is told to receive more stock rather than
  to retry. Matters more once several people pick at once.

## Rollback

```bash
git revert 16f912a && git push        # then re-trigger the deploy as above
```

The schema is additive, so a code rollback leaves the new tables in place, empty
and unused. Nothing needs to be dropped.
