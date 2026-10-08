# ProfitIndex on the Dell, behind Cloudflare

The Dell runs the app and its database. A **Cloudflare Tunnel** gives it an
HTTPS address with no router port-forwarding and no certificates to manage:

- **Now:** a temporary `https://….trycloudflare.com` link. No Cloudflare setup.
- **When your domain is ready:** `https://beta.<your-domain>`. One line in `.env`,
  same database, so everything entered so far is kept.

HTTPS isn't optional: phones only open the camera on a secure site, so a plain
`http://192.168.x.x` on the shop Wi-Fi can't scan. **R2** keeps the nightly
backups off the machine.

Nothing listens on the LAN. The database has no published port. The app is on
`127.0.0.1:4100` (the Dell itself, for debugging) and the tunnel.

| File | |
|---|---|
| `start.sh` | start everything in the background and print the address (writes `.env` on the first run) |
| `url.sh` | print the address the app is on right now |
| `compose.yaml` | the stack: `db`, `app`, `cloudflared`, and an on-demand `backup` job |
| `.env.example` | every setting; `.env` is never committed |
| `reset.sh` | wipe the beta back to a fresh install (backs up first, keeps the link) |
| `update.sh` | back up, pull, rebuild |
| `backup/` | the backup image: `pg_dump`, checked readable, copied to R2 |
| `restore.sh` | replace the live database from a backup, then prove the books |
| `drill.sh` | restore a backup into a scratch copy and prove it, leaving live data alone |
| `systemd/` | the nightly backup timer |

## 1. The machine

Ubuntu 24.04 LTS. **For a demo, only Docker (the last item) is needed.** The
rest keeps the app up unattended through power cuts and updates, which matters
once the business depends on it.

- **BIOS:** set *AC Recovery* (Power Management) to **Power On**, so the Dell
  comes back after a power cut.
- **Never sleep:**
  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```
  On a laptop, also ignore the lid:
  ```bash
  sudo mkdir -p /etc/systemd/logind.conf.d
  printf '[Login]\nHandleLidSwitch=ignore\n' | sudo tee /etc/systemd/logind.conf.d/profitindex.conf
  ```
  It applies on the next reboot. With the sleep targets masked, the Dell can't
  suspend in the meantime anyway.
- **Security updates install themselves:**
  ```bash
  sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
  ```
- **Docker Engine and the compose plugin.** If `docker compose version` already
  works (Ubuntu's own `docker.io` and `docker-compose-v2` packages work fine),
  keep it: this step is only for a machine without Docker. From Docker's own
  apt repository:
  ```bash
  sudo apt-get update && sudo apt-get install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"    # then log out and back in
  ```

## 2. Start it

```bash
sudo git clone -b claude/warehouse-mobile-scanning-8s2d64 https://github.com/alexthebinary/stockroom.git /opt/stockroom
sudo chown -R "$USER" /opt/stockroom
cd /opt/stockroom/v2/deploy
./start.sh
```

The first build takes a few minutes. Then it prints the address:

```
The app is at:   https://some-random-words.trycloudflare.com
Test sheet:      https://some-random-words.trycloudflare.com/test-sheet   (open on a laptop, or print it)
```

Everything runs in the background and restarts on its own, so you can close
the terminal. `./url.sh` prints the address again at any time.

- **Clone location:** it matters only for the backup timer (`systemd/`).
- **Private repository:** clone with a GitHub token or a read-only deploy key.
- **After merge:** once v2 is merged, clone `main` instead of the branch.
- **Packing-slip reader:** to turn it on, put `ANTHROPIC_API_KEY=…` in `.env`
  and run `./start.sh` again.

**About the temporary link:**

- **It changes whenever the tunnel restarts:** a reboot of the Dell, a crash,
  or an update that brings a new tunnel version. Run `./url.sh` and send the
  new link around. `./reset.sh` and ordinary updates keep it.
- **Testers shouldn't *Add to Home Screen* yet.** An installed app is tied to
  its address, so it would break when the link changes. A browser tab is fine.
- **It's Cloudflare's free test service:** no uptime promise, and about 200
  requests at once. That's plenty for a handful of testers.
- **Your domain brings the bot filtering and rate limit** in section 4. The
  temporary link doesn't have them.

## 3. Sharing the beta

1. **Set it up once yourself.** Open the link and go through the setup wizard
   (company, a few team names such as *Demo Clerk* and *Demo Accounting*, then
   **Add minimal sample data**). The wizard runs only once, so testers land on
   *Who's working?* instead. There they tap a name or add themselves.
2. **Send testers the link and the test sheet link.** They open the test sheet
   on a laptop (or print it) and scan it with their phone:
   *Receive a delivery*, then point the camera at the sheet. Whoever plays
   accounting opens the draft bill, adds freight, and *holds to post*.
3. **Wipe it between rounds of testing:** `./reset.sh` (it backs up first,
   and the link stays the same), then do step 1 again.

The link isn't listed by search engines (the app sends `noindex`), but anyone
who has it can use the beta, and change its data. That's fine for test data.
Before real stock and real bills go in, run `./reset.sh`, move to your own
domain, and consider the 5-minute email login under *Plainly stated*.

## 4. Your own domain (when ready)

All in the Cloudflare dashboard, on the account that has your domain.

**The tunnel.** Zero Trust → Networks → Tunnels → *Create a tunnel* →
*Cloudflared* → name it `profitindex` → choose *Docker* and copy the token
(the long string after `--token`). Then add a public hostname (newer
dashboards call it a *published application route*):

| Subdomain | Domain | Service |
|---|---|---|
| `beta` | your domain | `HTTP` · `app:4100` |

`app:4100` is the app's name on the compose network, which cloudflared shares.
The subdomain is yours to choose.

**Switch over.** Paste the token into `.env` as `TUNNEL_TOKEN=…`, then:

```bash
docker compose up -d      # only the tunnel restarts; the data stays
./url.sh                  # confirms it is on your own domain
```

Send testers the new link. It's permanent, so *Add to Home Screen* is fine
from now on. To go back to a temporary link, empty `TUNNEL_TOKEN` and run
`docker compose up -d` again.

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

## 5. Backups

They work as soon as the app does: dumps are kept on the Dell. Copying them
off the machine needs a free Cloudflare R2 bucket, and that doesn't need your
domain.

**The bucket.** R2 → *Create bucket* `profitindex-backups`. Then:

- In the bucket's settings, add an *object lifecycle rule*: delete objects
  after **90 days**.
- R2 → *Manage API tokens* → *Create API token*: **Object Read & Write**,
  limited to that one bucket. Put the Access Key ID, the Secret Access Key, and
  your Account ID (shown on the R2 overview) in `.env` as the `R2_*` values.

**The nightly timer:**

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
starts the app, and prints the books check. On a new machine, do sections 1
and 2 first (with the same `.env`), then restore from R2.

## 6. Updates

```bash
cd /opt/stockroom/v2/deploy && ./update.sh
```

It backs up first, then pulls, rebuilds, restarts, and prints the address.
Database migrations apply when the app starts. Phones pick up the new version
the next time they open the app.

## Plainly stated

- **The app is open to anyone on the internet.** That's the operator's decision
  (2026-10-08). There is no sign-in, so anyone who finds the address can read
  and change the books. What stands in front of it:
  - on your own domain, Cloudflare's bot filtering and the rate limit above;
  - strict security headers;
  - a database that isn't on the network;
  - backups off the machine.

  **To add an email login (needs your own domain), in about 5 minutes, with
  no code change:** Zero Trust → Access → Applications → *Add an application*
  → *Self-hosted* → `beta.<your-domain>`. Add a policy that allows your team's
  email addresses, and set the session to 30 days. Each person then gets a
  one-time code by email, about once a month. The app already loads its install
  manifest with credentials, so *Add to Home Screen* keeps working behind it.
- **If the shop's internet is down,** phones can't reach the Dell, even on the
  shop Wi-Fi, because the way in is through Cloudflare. Scans in a delivery
  that's already started stay queued on the phone and send themselves when
  it's back.
- **If the Dell is off,** nobody can use the app until it is back. The BIOS and
  sleep settings above are what keep it on.
