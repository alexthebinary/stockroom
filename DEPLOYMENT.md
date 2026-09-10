# Deploying Stockroom

## Why GitHub Pages cannot host this

Pages serves static files. This app is an Express server plus a database, so
Pages can host the *source*, not a running instance. There is no configuration
that changes that — it would need a Node process and a writable database, and
Pages provides neither.

The options that do work are below.

---

## 1. Tailscale — what is running now

Private, already set up, nothing exposed to the internet.

```bash
npm run build
HOST=100.66.113.79 \
  BASIC_AUTH_USER=demo BASIC_AUTH_PASSWORD='stockroom-beta' \
  npm run serve
```

Reachable from any device signed into the same tailnet at
`http://alex7770.tail4eda98.ts.net:4000`. The test device needs the Tailscale
app installed. Bound to the tailnet interface only, so it is invisible on the
local wifi.

**Best for:** you, testing from your own devices.
**Not for:** sending a link to someone who cannot install Tailscale.

---

## 2. Render — a public link, one shared database

`render.yaml` in the repo root is a complete blueprint. In Render: **New →
Blueprint**, point it at the GitHub repo, deploy. It provisions a free Postgres,
runs the migrations, seeds once, and serves the app.

Render generates the Basic auth password and shows it in the dashboard under the
service's Environment tab. The app login stays `demo@user.com` / `password`.

Notes worth knowing before you rely on it:

- **Free tier spins down after ~15 minutes idle**, and the next request takes
  ~30 seconds to cold-start. Fine for beta testing, surprising if you do not
  expect it.
- **The start command seeds the database.** That is right for a first deploy and
  wrong for every one after, because it would wipe what your testers entered.
  Remove `npm --prefix backend run seed &&` from `startCommand` once you have
  real data you care about.
- Postgres, not SQLite — Render's disk is ephemeral, so a SQLite file would be
  erased on each deploy.

**Best for:** sending a link to someone, and seeing the data they created.

---

## 3. Any container host — Fly.io, Cloud Run, a VPS

`Dockerfile` builds a single image serving the API and UI on one port. It
migrates on boot and deliberately does **not** seed.

```bash
fly launch --no-deploy          # writes fly.toml, picks a name
fly postgres create             # then attach it, which sets DATABASE_URL
fly secrets set BASIC_AUTH_USER=demo BASIC_AUTH_PASSWORD='<something long>'
fly deploy
```

**Best for:** no idle spin-down, or if you want a persistent volume and to keep
SQLite.

---

## Switching to Postgres

The schema is portable — no native enums, no `Decimal`, no `Json`, and the app
issues no raw SQL. Money is integer cents, which both databases store exactly.

`prisma/schema.prisma` stays SQLite for local work. `npm run schema:pg`
generates `prisma/schema.postgres.prisma` from it, so the two cannot drift; the
build scripts call it for you. Edit only `schema.prisma`.

One behavioural difference is handled in code: **Postgres `contains` is
case-sensitive and SQLite's is not.** Searching "widget" would stop matching
"Widget" on Postgres. `backend/src/search.ts` builds the filter to suit whatever
`DATABASE_URL` points at, which is why every search route calls `contains()`
rather than writing the filter inline.

---

## Before this is public, read this

The security model is a demo's:

- Basic auth is now a real boundary, but **behind it every API route is open** —
  there is no per-user authorisation, and the app login is a UI formality.
- Over Tailscale, Basic auth is safe because the transport is encrypted. Over
  plain HTTP it is not; the password would cross the wire readable. Render and
  Fly both terminate HTTPS, so a deploy there is fine — a bare
  `cloudflared tunnel` to an HTTP origin is not.
- `X-Demo-User` is trusted as written for audit fields. It is a label, not an
  identity.
- CORS is wide open, which is harmless while the UI and API share an origin.

None of that is a defect for a beta demo; all of it is a blocker for real data.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file path, or a Postgres connection string |
| `PORT` | Defaults to 4000 |
| `HOST` | Defaults to `127.0.0.1`. Use `0.0.0.0` on a container host, or a tailnet IP for Tailscale-only access |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Both set enables the gate; either missing disables it |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | Override the demo login |
