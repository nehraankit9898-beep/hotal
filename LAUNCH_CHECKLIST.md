# LAUNCH_CHECKLIST — StayLoop

Two gates: **[DEMO/STAGING]** (safe to show, not real customers) and
**[REAL CUSTOMERS]** (everything below must be green before the first paying
tenant). Work top-to-bottom; do not skip items marked REQUIRED.

Legend: ☐ pending · 🔧 requires your environment (domain, Docker, email
provider) — run the exact verification steps listed.

---

## A. Build & code quality — gate: CI green on YOUR repo

- ✅ `bun install --frozen-lockfile` (560 packages, exit 0)
- ✅ `bunx prisma generate --schema prisma/schema.postgres.prisma`
- ✅ `bun run typecheck` (exit 0)
- ✅ `bun run lint` (exit 0)
- ✅ `bun run build` (standalone server.js produced)
- ✅ Full test suite `bun run test` — ALL TEST SUITES PASSED (20 files, 245
  tests — including the 62 new deployment-fix regression tests)
- ✅ PG 16 integration suite — ALL 36 STEPS PASSED (real PostgreSQL 16.2:
  migrations incl. 0003, zero drift, standalone web + worker, bootstrap,
  MFA, exports, pg_dump backup, AES-256-GCM verify, DISPOSABLE-DB restore)
- ✅ `docker compose config` succeeds WITHOUT ADMIN_BOOTSTRAP_SECRET (real
  compose v2.32.4 — the inactive `admin` profile no longer blocks the stack)
- ✅ Caddyfile `validate` OK + admin `:2019/metrics` healthcheck endpoint
  answers HTTP 200 (real Caddy v2.8.4 binary)
- 🔧 CI workflow (`.github/workflows/ci.yml`) green on your fork — including
  the docker job (build with **--target web** + Trivy + compose startup +
  in-stack export/backup)

## B. Infrastructure (staging/VPS)

- 🔧 Docker Engine + compose plugin installed (DEPLOYMENT.md §1)
- 🔧 UFW: 22, 80, 443 only; Docker published ports limited to 80/443 (caddy)
- 🔧 DNS A record → VPS IP, propagated
- 🔧 `.env` from `.env.production.example`, EVERY value filled:
  - AUTH_SECRET / INTEGRATION_ENCRYPTION_KEY: fresh `openssl rand -hex 32`
    (never reuse any value that appeared in a repo/zip)
  - DATABASE_PASSWORD (hex) + DATABASE_URL with the SAME password
  - DOMAIN / ACME_EMAIL / APP_ORIGIN (https)
- 🔧 `docker compose -f docker-compose.prod.yml up -d --build`
- 🔧 `docker compose ps` → postgres, redis, web, worker all `healthy`,
  `migrate` exited 0
- 🔧 `curl https://DOMAIN/api/health` → 200 `{"status":"ok",…}`
- 🔧 `curl https://DOMAIN/api/health/live` → 200
- 🔧 Port exposure checks (from the VPS): `ss -tlnp` shows 3000 on
  127.0.0.1 only; 5432/6379 not published; from outside, :3000/:5432/:6379
  unreachable
- 🔧 HTTPS: valid Let's Encrypt cert, HTTP→HTTPS redirect, HSTS header
- 🔧 Session cookie: `Secure` + `HttpOnly` (browser DevTools)

## C. First-run security setup (REQUIRED before anyone else gets access)

- 🔧 Super admin bootstrap via the one-shot `admin` profile service
  (operator-supplied --name/--email; temporary password shown ONCE)
- 🔧 Forced password change completed (old session revoked — verified ✅ in
  the integration run; repeat on your host)
- 🔧 MFA (TOTP) enrolled; one-time backup codes stored in a password manager
- 🔧 Super-admin dashboard usable post-MFA (verified ✅ locally; repeat)
- 🔧 **ADMIN_BOOTSTRAP_SECRET removed from `.env`** + `docker compose up -d`
- ☐ Review /api/super-admin/security: set `maxFailedLoginsPerHour` to taste
- ☐ Confirm platform MFA policy covers SUPER_ADMIN (default: on)

## D. Email & messaging honesty (REQUIRED if users sign up)

- 🔧 SMTP/Resend/SendGrid configured (`EMAIL_PROVIDER`, credentials,
  `EMAIL_FROM`); test email received in a real inbox
- 🔧 With REQUIRE_EMAIL_VERIFICATION=true: registration email arrives
- ☐ (If you deliberately run WITHOUT email): confirm you accept that
  verification/reset emails fail honestly (logged, never faked) and
  REQUIRE_EMAIL_VERIFICATION=false
- ☐ WhatsApp/Twilio: either real credentials or accept the explicit
  "simulation" mode labeling in campaigns UI

## E. Data & tenant safety

- ✅ Migrations apply on clean PG 16 (`prisma migrate deploy`, exit 0)
- ✅ Migrations == schema (empty drift via shadow DB)
- ✅ Tenant isolation suite passes (rbac-tenant, phase10 deny-matrix)
- ✅ Cross-tenant export download → 404 (indistinguishable)
- ☐ Load REAL customer data only AFTER the [REAL CUSTOMERS] gate below
- ☐ Data-processing/privacy review for your jurisdiction (consent records,
  retention months in Platform Settings)

## F. Backups & disaster recovery (REQUIRED before real customers)

- ✅ Manual backup → worker pg_dump → AES-256-GCM archive (0640)
- ✅ "Verify last" = real decrypt (ok:true)
- ✅ Restore into a disposable PostgreSQL database (row counts verified)
- 🔧 Repeat on YOUR host (DEPLOYMENT.md §9) with your volume paths
- 🔧 Scheduled backups enabled in Platform Settings (interval + retention)
- 🔧 First scheduled backup appeared in the history automatically
- 🔧 At least one archive copied OFF the server (scp/rclone) and restored
  on another machine
- 🔧 Restore drill logged with date + operator (repeat quarterly)
- ☐ Encryption key rotation procedure read (DEPLOYMENT.md §9 /
  docs/SECRET_ROTATION.md) — previous-keys line keeps old archives readable

## G. Operations & observability

- ✅ Liveness/readiness split: /api/health/live vs /api/health (both 200)
- ✅ Worker heartbeat visible in /api/health (`checks.worker:"ok"`) and
  stale-heartbeat → readiness 503 (unit-proven classification)
- 🔧 Uptime monitor on https://DOMAIN/api/health (alert on != 200)
- 🔧 Log shipping wired (docker logs → your pipeline; JSON lines)
- 🔧 Alert on: readiness 503, worker stale, rising FAILED job count
  (Super Admin → Health), failed backups
- ✅ Queue DLQ semantics: exhausted attempts dead-letter (bounded retries)
- ✅ Two-worker safety (unit-proven this release): scheduled-backup CAS
  claim — 4 racing workers produce exactly ONE backup; payment-confirmation
  outbox — concurrent runs redeem a coupon exactly once and create exactly
  one ACTIVE subscription; refund race — concurrent refunds cannot
  over-refund
- 🔧 Two-worker soak (optional scale test): `--scale worker=2`, one export
   completes exactly once, kill -TERM one worker → clean recovery

## H. Release hygiene (sanitization)

- ✅ No real credentials/demo passwords/databases/customer data in the
  release zip (demo SQLite DB removed; dev bootstrap = `bun run dev:setup`)
- ✅ `.env.production.example` contains placeholders only
- ✅ Secret scan (`bun run scripts/scan-secrets.ts`) run on the packaged tree
- ✅ No `.env` / `.auth-secret.dev` / logs / `var/` artifacts packaged

---

# [DEMO/STAGING READY] — you may demo when ALL of these hold

1. CI green (A) on your repo — including the docker job.
2. B complete: stack healthy, HTTPS live, health 200.
3. C complete: super admin has a real password + MFA; bootstrap secret removed.
4. F-lite: one manual backup taken and verified ("Verify last" ok).
5. D-lite: either real email configured, or you knowingly accept honest
   failure mode with REQUIRE_EMAIL_VERIFICATION=false.
6. Only synthetic/demo data in the database.

# [REAL CUSTOMERS READY] — ALL of the above PLUS

1. F complete: scheduled backups running, off-server copies, **restore drill
   performed and logged on the production host**.
2. D complete: real email provider delivering (verification + reset tested
   in real inboxes).
3. G complete: uptime monitoring + log shipping + alerts live.
4. Consent & retention settings reviewed for your jurisdiction (E).
5. B under change control: `.env` secrets in a vault/manager, rotation
   procedure for AUTH_SECRET / INTEGRATION_ENCRYPTION_KEY documented and
   scheduled; INTEGRATION_ENCRYPTION_PREVIOUS_KEYS ready for rotation.
6. Billing providers (Razorpay/Stripe) — if used:
   - webhook secret configured per provider (Super Admin → Billing);
   - a sandbox payment round-trip: checkout → paid → subscription ACTIVE;
   - a REPLAYED webhook rejected (invalid signature) — verify in
     Super Admin → Security events (WEBHOOK_REJECTED).
7. Rollback rehearsed: previous image tagged/available; the §11 rollback
   steps walked through once on staging.
8. Support inbox monitored (Super Admin → Support queue) and first-response
   owner assigned.

**If any REAL-CUSTOMER item cannot be completed, do not onboard paying
tenants — fix or explicitly accept the risk in writing.**
