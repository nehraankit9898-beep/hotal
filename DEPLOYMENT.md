# StayLoop — Production Deployment Guide (Ubuntu VPS + Docker Compose)

This guide takes a **fresh Ubuntu 22.04/24.04 VPS** to a running, HTTPS-secured
StayLoop installation. Every command is copy-paste ready and was verified end
to end on a clean VPS before this release.

> **Time needed:** ~30–45 minutes (mostly waiting for builds).
> **Skills needed:** copy-paste into a terminal. Explanations are provided
> for every step so you know what you are doing.

---

## 0. What you need before starting

| Requirement | Example |
|---|---|
| A VPS with Ubuntu 22.04 or 24.04, 2 GB RAM minimum | any provider |
| Root/sudo access on the VPS | you will install Docker |
| A domain name you control | `stayloop.example.com` |
| Ability to create a DNS **A record** | in your registrar's DNS panel |
| An email address for Let's Encrypt notices | `ops@example.com` |
| SMTP or an email API key (optional, for user emails) | any provider |

The stack that will run (all inside Docker, nothing else on the VPS):

```
caddy (80/443, HTTPS) → web (Next.js, port 3000 internal)
                        worker (background jobs, backups)
                        migrate (one-shot schema setup)
postgres:16 (database, internal only)   redis:7 (rate limits, internal only)
```

---

## 1. Fresh VPS setup (SSH in, create a user, install Docker)

```bash
# 1.1 SSH into your server as root (replace the IP).
ssh root@YOUR_SERVER_IP

# 1.2 Create a deploy user (answer the prompts; use a strong password).
adduser stayloop
usermod -aG sudo stayloop

# 1.3 Log in as that user from now on.
exit
ssh stayloop@YOUR_SERVER_IP

# 1.4 Update the system.
sudo apt-get update && sudo apt-get upgrade -y

# 1.5 Install Docker + the compose plugin (official repo).
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 1.6 Allow the deploy user to use Docker without sudo.
sudo usermod -aG docker stayloop
# Log out and back in (new group membership), then verify:
docker ps     # should print an empty table, no permission error
```

**Firewall:** allow SSH, HTTP and HTTPS only:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

## 2. Upload and extract the application

```bash
# 2.1 Install unzip if missing, create the app directory.
sudo apt-get install -y unzip
sudo mkdir -p /opt/stayloop
sudo chown stayloop:stayloop /opt/stayloop

# 2.2 Upload the release zip from your computer (run this ON YOUR COMPUTER):
scp stayloop-phase10-release.zip stayloop@YOUR_SERVER_IP:/opt/stayloop/

# 2.3 Back on the server, extract:
cd /opt/stayloop
unzip -q stayloop-phase10-release.zip
# If the zip unpacked into a subfolder, cd into it — you want the folder
# that contains docker-compose.prod.yml.
ls    # should show: Dockerfile, docker-compose.prod.yml, prisma/, src/, package.json, bun.lock, ...
```

## 3. Configure the environment (the only file you edit)

```bash
cd /opt/stayloop
cp .env.production.example .env
nano .env      # or vi
```

Fill in **every** value. The application refuses to start if required secrets
are missing or weak — that is deliberate (fail closed).

**Generate the secrets** (run these three commands on the server and paste
each result into the file):

```bash
openssl rand -hex 32   # → AUTH_SECRET
openssl rand -hex 32   # → INTEGRATION_ENCRYPTION_KEY
openssl rand -hex 32   # → ADMIN_BOOTSTRAP_SECRET (used ONCE in step 6)
```

**Database values** (audited fix — the postgres container and the app must
agree):

```bash
openssl rand -hex 24   # → DATABASE_PASSWORD  (hex = no URL-encoding issues)
```

Then set, with the SAME password in both places:

```ini
DATABASE_PASSWORD=the-hex-value-you-generated
DATABASE_URL=postgresql://stayloop:the-hex-value-you-generated@postgres:5432/stayloop?schema=public&connection_limit=20
```

> ⚠️ **URL-encoding:** if you ever choose a password containing characters
> like `@ : / ? # &`, you must percent-encode them in `DATABASE_URL`
> (`@`→`%40`, `:`→`%3A`, `/`→`%2F`). Using the hex password from
> `openssl rand -hex 24` avoids this entirely.

Also set:

```ini
DOMAIN=stayloop.example.com          # your domain — DNS in step 4
ACME_EMAIL=ops@example.com          # Let's Encrypt expiry notices
APP_ORIGIN=https://stayloop.example.com
```

Email (optional but recommended — user verification / password reset):

```ini
REQUIRE_EMAIL_VERIFICATION=true
EMAIL_PROVIDER=smtp
SMTP_URL=smtps://user:password@smtp.yourprovider.com:465
EMAIL_FROM=StayLoop <no-reply@example.com>
```

> Same URL-encoding rule for the SMTP password. `mock` is **rejected** in
> production — with no provider configured, emails fail honestly (logged)
> instead of pretending to be sent.

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X` in nano). Protect the file:

```bash
chmod 600 .env
```

## 4. Domain / DNS and HTTPS

In your DNS provider's panel, create an **A record** pointing your domain at
the VPS:

```
Type: A    Name: stayloop (or @ for the root domain)    Value: YOUR_SERVER_IP
```

Wait for DNS to propagate (usually minutes; check with
`ping stayloop.example.com` — it should resolve to your server IP).

Caddy obtains and renews the Let's Encrypt certificate **automatically**
when the stack starts. HTTPS is mandatory — session cookies are `Secure`.

> First-time testing without burning Let's Encrypt rate limits? Edit
> `Caddyfile`, uncomment the `acme_ca ...staging...` line, start the stack,
> verify, comment it back out and restart (`docker compose -f
> docker-compose.prod.yml restart caddy`).

## 5. Start the stack (migrations run first, automatically)

```bash
cd /opt/stayloop
docker compose -f docker-compose.prod.yml up -d --build
```

What happens, in order (enforced by healthchecks — just wait):

1. `postgres` + `redis` start and become healthy.
2. `migrate` applies **all** database migrations (one-shot; the stack refuses
   to continue if a migration fails). This is `prisma migrate deploy` —
   non-destructive by design: it never resets or drops data.
3. `web` and `worker` start; `caddy` serves your domain on 80/443.

Watch the progress:

```bash
docker compose -f docker-compose.prod.yml ps
```

All of `postgres`, `redis`, `web`, `worker` should show `healthy` (web may
take ~1–2 minutes the first time). Then verify over HTTPS:

```bash
curl -fsS https://stayloop.example.com/api             # {"ok":true}     (liveness)
curl -fsS https://stayloop.example.com/api/health/live # {"ok":true}     (liveness)
curl -fsS https://stayloop.example.com/api/health      # {"status":"ok",...} (readiness)
```

Open `https://stayloop.example.com` in a browser — the login page should load
over HTTPS with a valid padlock.

**Checks (verified in this release's integration run):**
the app port 3000 is bound to `127.0.0.1` only (not reachable from the
internet — everything must pass through Caddy); PostgreSQL and Redis are not
published at all.

## 6. First super-admin setup (once), password change, MFA

> Do this once. The account cannot use the platform until the password is
> changed, and the dashboard unlocks only after MFA (TOTP) is set up.

```bash
cd /opt/stayloop
docker compose -f docker-compose.prod.yml --profile admin run --rm admin \
  --name "Platform Admin" \
  --email you@example.com
```

- Requires `ADMIN_BOOTSTRAP_SECRET` in `.env` (set in step 3).
- Prints a **temporary password once, on your terminal only** — copy it now.
- Copy it into a password manager; the password is never stored or logged.

Then in the browser:

1. Go to `https://stayloop.example.com` → super-admin sign-in
   (`you@example.com` + the temporary password).
2. You are forced to change the password immediately
   (`PASSWORD_CHANGE_REQUIRED`). All other sessions are revoked.
3. Sign in again → MFA enrolment is enforced (`MFA_SETUP_REQUIRED`):
   scan the QR code with an authenticator app (Google Authenticator, 1Password,
   Aegis…), enter the 6-digit code, and **save the one-time backup codes**
   somewhere safe (shown exactly once).
4. The Control Center dashboard loads — you are in.

**Now remove the bootstrap secret** (it must not stay in `.env`):

```bash
nano .env     # delete the ADMIN_BOOTSTRAP_SECRET line entirely
docker compose -f docker-compose.prod.yml up -d   # recreate affected services
```

The stack keeps working with the secret removed — the one-shot `admin`
service is optional at compose level and **fails closed inside the script**
if anyone tries to run it without the secret (audit fix deploy-4: the
service previously used required `${ADMIN_BOOTSTRAP_SECRET:?…}`
interpolation, which broke EVERY compose command after the secret was
removed, because compose interpolates the whole file before profile
filtering).

Until removed, anyone with server access could create a super admin — the
bootstrap refuses to run when a super admin already exists, but removing the
secret eliminates the risk entirely.

## 7. Email / messaging providers

- **SMTP (any provider incl. AWS SES SMTP):** `EMAIL_PROVIDER=smtp` +
  `SMTP_URL` + `EMAIL_FROM`.
- **Resend:** `EMAIL_PROVIDER=resend` + `RESEND_API_KEY`.
- **SendGrid:** `EMAIL_PROVIDER=sendgrid` + `SENDGRID_API_KEY`.
- `EMAIL_PROVIDER=auto` picks the first configured one.
- Messaging (WhatsApp Cloud API, Twilio SMS): fill `WHATSAPP_*` /
  `TWILIO_*` in `.env` — without them those channels run in honest
  "simulation" mode and are reported as such.

Restart after changes: `docker compose -f docker-compose.prod.yml up -d`.

## 8. Health checks, logs, monitoring

```bash
# Liveness (process up — for restart-on-crash decisions):
curl -fsS https://stayloop.example.com/api/health/live

# Readiness (DB + queue + redis + worker heartbeat + email policy — for
# load-balancer routing / uptime alerts). 503 = NOT ready:
curl -fsS https://stayloop.example.com/api/health

# Detailed system health (super-admin login required, in-browser):
https://stayloop.example.com → Control Center → Health
```

The public endpoints stay deliberately low-information (no counts, no
credentials). The worker writes a heartbeat every 30 s — a stale heartbeat
makes readiness fail (and the worker's own Docker healthcheck restarts a
wedged worker).

```bash
# Logs (JSON lines):
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs -f caddy
```

## 9. Backups

Encrypted (AES-256-GCM) `pg_dump` backups run **on the worker** (the
PostgreSQL 16 client ships in the image; credentials are passed via
environment variables — never on the command line, never in logs).

- **Scheduled:** Control Center → Platform Settings → enable backups
  (interval + retention). The worker runs them automatically.
- **Manual:** Control Center → Backups & DR → "Run backup now" (queued —
  the worker picks it up within seconds and it appears in the history).
- **Verify:** "Verify last" performs a REAL decryption of the archive
  (auth-tag checked), not just a header sniff.
- Archives live on the `backups` Docker volume, mode 0640, no world access.

**Copy backups OFF the server** (strongly recommended — a VPS is not a backup):

```bash
# On YOUR computer, fetch the latest archive:
ssh stayloop@YOUR_SERVER_IP \
  'docker exec stayloop-worker-1 sh -c "ls -t /app/var/backups/*.slbkp.enc | head -1"' | \
  xargs -I{} scp stayloop@YOUR_SERVER_IP:{} ./stayloop-backup-copy.enc
```

### Restore (verified end-to-end during this release)

Restores are **destructive to the target database** — always restore into a
DISPOSABLE database first, verify, then cut over. The restore runs in a
SINGLE TRANSACTION with `--exit-on-error` (a failure leaves the target
untouched), and the connection URL never appears on the command line
(credentials travel via `PG*` environment variables only):

```bash
cd /opt/stayloop
# Decrypt + pg_restore into a scratch database + print row counts:
# (archive names end with the backup record id — use the one you copied off)
docker compose -f docker-compose.prod.yml exec -T -w /app worker \
  bun run scripts/restore-backup.ts \
    /app/var/backups/stayloop-backup-YYYY-MM-DDTHH-MM-SS-sssZ-XXXXXXXX.slbkp.enc \
    --target "postgresql://stayloop:$(grep '^DATABASE_PASSWORD=' .env | cut -d= -f2)@postgres:5432/stayloop_restore_test"
```

When the counts look right, the production cutover is:
`docker compose down` → restore into `stayloop` (after renaming the current
DB) → `docker compose up -d` → verify `/api/health`. Full runbook:
`docs/DISASTER_RECOVERY.md`.

### Encryption-key rotation

`INTEGRATION_ENCRYPTION_KEY` encrypts backups AND integration credentials.
Rotate by: 1) generate a new key, 2) add the old one to
`INTEGRATION_ENCRYPTION_PREVIOUS_KEYS` as `old:<64-hex>` (keeps existing
backups verifiable/decryptable), 3) swap `INTEGRATION_ENCRYPTION_KEY`, 4) run
a new backup + "Verify last". Details: `docs/SECRET_ROTATION.md`.

## 10. Updates (new release)

```bash
cd /opt/stayloop
# 10.1 Take a fresh backup first (see §9) and copy it off-server.
# 10.2 Upload the new zip, extract next to the old one, copy your .env:
cp .env /opt/stayloop-new/.env
# 10.3 Rebuild + restart; migrations apply automatically and safely:
docker compose -f docker-compose.prod.yml up -d --build
# 10.4 Verify:
curl -fsS https://stayloop.example.com/api/health
```

## 11. Rollback

```bash
cd /opt/stayloop
docker compose -f docker-compose.prod.yml down
# Point the deployment back at the previous release directory (keep the last
# one), keeping the SAME .env, then:
docker compose -f docker-compose.prod.yml up -d --build
```

If a migration must also be reverted, restore the pre-migration backup
(§9 restore + cutover) — Prisma migrations are not auto-reversible, which is
why the pre-update backup is mandatory.

---

## Quick reference

| Task | Command |
|---|---|
| Start / stop | `docker compose -f docker-compose.prod.yml up -d` / `down` |
| Status | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f web` |
| Health | `curl -fsS https://DOMAIN/api/health` |
| Backup now | Super Admin UI → Backups & DR → Run backup now |
| Verify backup | Super Admin UI → Backups & DR → Verify last |
| Restore (test) | §9 restore command |
| First admin | §6 `--profile admin run --rm admin` |
| Update | §10 |
| Rollback | §11 |

## Local development (SQLite — separate from production)

```bash
bun install --frozen-lockfile
cp .env.example .env            # dev defaults; no secrets needed
bun run dev:setup               # creates + seeds the local SQLite demo DB
bun run dev                     # http://localhost:3000
bun run worker                  # background jobs in a second terminal
bun run test                    # full security/functional suite
```

Production always uses PostgreSQL; a `file:` DATABASE_URL is rejected at
startup when `NODE_ENV=production`.

---

## Verification checklist for this deployment

- [ ] `docker compose ps` — postgres, redis, migrate (exited 0), web, worker all healthy
- [ ] `curl https://DOMAIN/api` → `{"ok":true}`
- [ ] `curl https://DOMAIN/api/health` → 200 `{"status":"ok",...}`
- [ ] Browser: HTTPS padlock, login page loads
- [ ] Super-admin bootstrap done; `ADMIN_BOOTSTRAP_SECRET` removed from `.env`
- [ ] Password changed + MFA enrolled (backup codes stored)
- [ ] Email provider configured (or intentionally acknowledged as off)
- [ ] Manual backup run + "Verify last" → verified
- [ ] Restore tested into a disposable database
- [ ] Backups copied off-server
- [ ] `ss -tlnp | grep 3000` → only 127.0.0.1 listens on 3000 (not public)
- [ ] UFW active: 22, 80, 443 only
