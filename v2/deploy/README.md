# ProfitIndex on the Dell, behind Cloudflare

The Dell runs the app and its database. Cloudflare sits in front: a
**Cloudflare Tunnel** gives a real `https://beta.<your-domain>` address with no
router port-forwarding and no certificates to manage, and **R2** keeps the
nightly backups off the machine. HTTPS isn't optional: phones only open the
camera on a secure site, so a plain `http://192.168.x.x` on the shop Wi-Fi
can't scan.

Nothing listens on the LAN. The database has no published port. The app is on
`127.0.0.1:4100` (the Dell itself, for debugging) and the tunnel.

| File | |
|---|---|
| `compose.yaml` | the stack: `db`, `app`, `cloudflared`, and an on-demand `backup` job |
| `.env.example` | every setting; copy to `.env` (never committed) |
| `demo.sh` | try it first: no Cloudflare account, a temporary https address |
| `backup/` | the backup image: `pg_dump`, checked readable, copied to R2 |
| `restore.sh` | replace the live database from a backup, then prove the books |
| `drill.sh` | restore a backup into a scratch copy and prove it, leaving live data alone |
| `update.sh` | back up, pull, rebuild |
| `reset.sh` | wipe the beta back to a fresh install (backs up first) |
| `systemd/` | the nightly backup timer |

## 0. Try it first (5 minutes)

On the Dell, or any Linux or Mac machine with Docker:

```bash
git clone -b claude/warehouse-mobile-scanning-8s2d64 https://github.com/alexthebinary/stockroom.git
cd stockroom/v2/deploy
./demo.sh
```

The first build takes a few minutes. Then it prints an address like
`https://some-random-words.trycloudflare.com`. Open that on a phone:

1. The setup wizard opens: company, team, then **Add minimal sample data**.
2. On a laptop, open the same address at `/test-sheet` (or print it). It has
   the sample barcodes and a packing slip.
3. On the phone, tap your name, **Receive a delivery**, and point the camera at
   the sheet.
4. Switch to the accounting person, open the draft bill, add freight, **hold to post**.

`Ctrl-C` drops the temporary address (the app keeps running; run `./demo.sh`
again for a new address). `./demo.sh reset` wipes the demo back to a fresh
install. `./demo.sh stop` stops it. The demo keeps its own database, so the
real install below still starts clean; stop the demo before going live (they
share port 4100).

A quick-tunnel address is temporary and has no uptime promise. It's for
trying the app, not for running the business. To try the packing-slip reader
in the demo, put `ANTHROPIC_API_KEY=…` in `deploy/.env` first.

## 1. The machine

Ubuntu 24.04 LTS. Then:

- **BIOS:** set *AC Recovery* (Power Management) to **Power On**, so the Dell
  comes back after a power cut.
- **Never sleep:**
  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```
  On a laptop, also set `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`.
- **Security updates install themselves:**
  ```bash
  sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
  ```
- **Docker Engine and the compose plugin** (Docker's own apt repository):
  ```bash
  sudo apt-get update && sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"    # then log out and back in
  ```

## 2. Cloudflare

All in the Cloudflare dashboard, on the account that has your domain.

**The tunnel.** Zero Trust → Networks → Tunnels → *Create a tunnel* →
*Cloudflared* → name it `profitindex` → choose *Docker* and copy the token
(the long string after `--token`). Then add a public hostname (newer
dashboards call it a *published application route*):

| Subdomain | Domain | Service |
|---|---|---|
| `beta` | your domain | `HTTP` · `app:4100` |

`app:4100` is the app's name on the compose network, which cloudflared shares.
The subdomain is yours to choose (see *Sharing the beta* below).

**Abuse filtering** (free):

- Security → Bots → **Bot Fight Mode** on. If a phone ever sees "blocked"
  errors, turn this off first.
- Security → WAF → **Rate limiting rules** → create:
  - *If* `(http.request.method ne "GET" and starts_with(http.request.uri.path, "/api/"))`
  - *with the same* IP
  - *more than* **150 requests per 10 seconds** → **Block** for 10 seconds.

  A whole shop on one Wi-Fi shares an IP, so the limit is generous. A phone
  that was offline sends its queued scans in a burst, and retries if it is
  held back.

**Backups bucket.** R2 → *Create bucket* `profitindex-backups`. Then:

- In the bucket's settings, add an *object lifecycle rule*: delete objects
  after **90 days**.
- R2 → *Manage API tokens* → *Create API token*: **Object Read & Write**,
  limited to that one bucket. Note the Access Key ID, the Secret Access Key,
  and your Account ID (shown on the R2 overview).

## 3. The app

```bash
sudo git clone -b claude/warehouse-mobile-scanning-8s2d64 https://github.com/alexthebinary/stockroom.git /opt/stockroom
sudo chown -R "$USER" /opt/stockroom
cd /opt/stockroom/v2/deploy
cp .env.example .env
nano .env        # POSTGRES_PASSWORD (openssl rand -hex 24), TUNNEL_TOKEN, R2_*, optionally ANTHROPIC_API_KEY
docker compose up -d --build
docker compose ps     # db, app and cloudflared: running / healthy
```

The repository path matters only for the backup timer (`systemd/`). If the
repository is private, clone with a GitHub token or a read-only deploy key.
Once v2 is merged, clone `main` instead of the branch.

Open `https://beta.<your-domain>` on a phone. It works over mobile data too,
not just the shop Wi-Fi. The setup wizard opens; then *Share → Add to Home
Screen* (iPhone) or *Install app* (Android).

## 4. Backups

```bash
sudo cp systemd/profitindex-backup.service systemd/profitindex-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now profitindex-backup.timer
sudo systemctl start profitindex-backup          # one now, to see it work
journalctl -u profitindex-backup -n 20           # "dumped …" then "copied to r2:…"
```

Check that the file appears in the R2 bucket. Every night at 02:30 a dump is
written to `deploy/backups/` (the newest 14 are kept), checked readable, and
copied to R2 (kept 90 days). If the Dell was off at 02:30, it runs once the
Dell is back.

Set `HEALTHCHECK_URL` (a free healthchecks.io check, say) and you'll get an
email the first night a backup doesn't arrive.

**Restore drill.** Do this once now, then every few months:

```bash
./drill.sh       # restores the newest dump into a scratch database and proves the books
```

It never touches the live database and ends with `drill passed`.

**A real restore** (dead disk, bad day):

```bash
./restore.sh backups/profitindex-20261008-0230.dump    # a dump on the Dell
./restore.sh profitindex-20261008-0230.dump            # or one fetched from R2
```

It asks you to type `RESTORE`. Then it stops the app, replaces the database,
starts the app, and prints the books check. On a new machine, do sections 1 to 3
first, then restore from R2.

## Sharing the beta

The address for testers is `https://beta.<your-domain>`. It's a plain browser
link, with nothing to install and no account.

1. **Set it up once yourself.** Open the link and go through the setup wizard
   (company, a few team names such as *Demo Clerk* and *Demo Accounting*, then
   **Add minimal sample data**). The wizard runs only once, so testers land on
   *Who's working?* instead. There they tap a name or add themselves.
2. **Send testers the link, plus `https://beta.<your-domain>/test-sheet`.**
   They open the test sheet on a laptop (or print it) and scan it with their
   phone. On a phone they can also *Add to Home Screen*.
3. **Wipe it between rounds of testing:** `./reset.sh` (it backs up first),
   then do step 1 again.

The link isn't listed by search engines (the app sends `noindex`), but anyone
who has it can use the beta, and change its data. That's fine for test data.
**Before real stock and real bills go in,** pick one of these:

- `./reset.sh` and keep using the same link (simplest; installed phones keep
  working);
- or move to a separate `app.` address with its own database (ask for it then;
  the beta can keep running beside it).

Either way, the 5-minute email login under *Plainly stated* is worth turning
on at that point.

## 5. Updates

```bash
cd /opt/stockroom/v2/deploy && ./update.sh
```

It backs up first, pulls, rebuilds, and restarts. Database migrations apply
when the app starts. Installed phones pick up the new version the next time
they open the app.

## Plainly stated

- **The app is open to anyone on the internet.** That's the operator's decision
  (2026-10-08). There is no sign-in, so anyone who finds the address can read
  and change the books. What stands in front of it:
  - Cloudflare's bot filtering and the rate limit above;
  - strict security headers;
  - a database that isn't on the network;
  - backups off the machine.

  **To add an email login later, in about 5 minutes, with no code change:**
  Zero Trust → Access → Applications → *Add an application* → *Self-hosted* →
  `beta.<your-domain>`. Add a policy that allows your team's email addresses,
  and set the session to 30 days. Each person then gets a one-time code by
  email, about once a month. The app already loads its install manifest with
  credentials, so *Add to Home Screen* keeps working behind it.
- **If the shop's internet is down,** phones can't reach the Dell, even on the
  shop Wi-Fi, because the way in is through Cloudflare. Scans in a delivery
  that's already started stay queued on the phone and send themselves when
  it's back.
- **If the Dell is off,** nobody can use the app until it is back. The BIOS and
  sleep settings above are what keep it on.
