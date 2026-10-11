# StayLoop Deployment Guide

> **The beginner-friendly, step-by-step guide with verified copy-paste
> commands now lives at the repository root: [`DEPLOYMENT.md`](../DEPLOYMENT.md).**
> Use that one for a fresh install. This file keeps the condensed operator
> reference (scaling, logging, rollback, non-Docker notes).

Production deployment with Docker Compose is the supported path. All values
that differ per environment live in `.env` (never in images or code).

## 0. Prerequisites

- Docker Engine 24+ with the compose plugin
- A PostgreSQL 16 server (or use the bundled compose service)
- A Redis 7 instance (recommended; required for multi-instance web/worker)
- DNS + TLS termination (HTTPS is mandatory: cookies are `Secure`)
- Secrets generated per `docs/SECRET_ROTATION.md`

## 1. Configure the environment

```bash
cp .env.production.example .env
# Fill EVERY value. Nothing may remain empty or placeholder:
#   AUTH_SECRET, DATABASE_URL, INTEGRATION_ENCRYPTION_KEY  (required — fail closed)
#   TRACKING_WEBHOOK_SECRET, FOLLOWUP_ENGINE_SECRET        (strongly recommended)
#   APP_ORIGIN, EMAIL_FROM + one email provider, REDIS_URL
openssl rand -hex 32   # for each required secret
```

The application refuses to boot when a required secret is missing, weak, or a
known placeholder (see `src/instrumentation.ts`, `src/lib/config.ts`,
`src/lib/env.ts`). This is intentional.

## 2. Launch the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

Service order is enforced by healthchecks:

1. `postgres`, `redis` become healthy
2. `migrate` runs `prisma migrate deploy` (one-shot, must exit 0)
3. `web` (port 3000) and `worker` start

## 3. Post-deploy verification

```bash
curl -fsS https://your-domain/api            # → {"ok":true}
curl -fsS https://your-domain/api/health     # → {"status":"ok",...} (200)
docker compose -f docker-compose.prod.yml ps # web + worker healthy
```

Create the first super admin exactly once (the dedicated one-shot service —
the web image does not ship bootstrap scripts):

```bash
# Set ADMIN_BOOTSTRAP_SECRET in .env temporarily, then:
docker compose -f docker-compose.prod.yml --profile admin run --rm admin \
  --name "Platform Admin" --email you@example.com
# REMOVE ADMIN_BOOTSTRAP_SECRET from .env afterwards and `up -d` again.
```

## 4. Migrations (safety rules)

- Migrations are applied by the one-shot `migrate` service before any app
  container starts (`prisma/migrations/0001_init` for the initial schema).
- Never run destructive commands (`migrate reset`, `db push --accept-data-loss`)
  against production.
- Before applying a new migration: take a backup
  (`docs/BACKUP_AND_RESTORE.md`), test the migration on a staging copy, and
  keep the rollback path ready (`docs/DISASTER_RECOVERY.md`).

## 5. Scaling notes

- **web** is stateless (sessions are HMAC tokens + DB state) — scale
  horizontally behind a load balancer. Set `REDIS_URL` so rate limits are
  shared; otherwise per-instance buckets apply (documented limitation).
- **worker** can run multiple replicas; job claims are protected by an
  optimistic status-checked update, so work is never double-processed. At
  least ONE worker must always run or queued sends/exports stall.
- The `exports` volume must be shared by all web+worker replicas that serve
  downloads.

## 6. Logging & monitoring

- Application logs are JSON lines on stdout — ship them with any
  container-log pipeline (`docker logs`, Loki, CloudWatch…).
- Correlate requests with the `x-request-id` response header.
- Probe `/api` and `/api/health/live` (liveness) and `/api/health`
  (readiness) from your orchestrator/uptime monitor. Alert on
  `status != "ok"` and on rising `failed` job counts
  (`/api/super-admin/health`, authenticated). A STALE worker heartbeat also
  fails readiness (observable heartbeat, not just process-exists).
- Security events land in the `AuditLog` table; review via the admin UI.

## 7. Rollback

```bash
# Previous image
docker compose -f docker-compose.prod.yml down
docker tag stayloop-web:<previous> stayloop-web:rollback   # if tagged
docker compose -f docker-compose.prod.yml up -d
```

- If a migration must be reverted, restore the pre-migration backup
  (see `docs/DISASTER_RECOVERY.md`) — Prisma migrations are not auto-reversible.
- Application rollback never requires data rollback unless the migration
  changed schema destructively — which is why migrations are reviewed and
  backed up first.

## 8. Non-Docker deployment (bare VM)

1. Node 24 / Bun 1.3.14, PostgreSQL 16, Redis 7
2. `bun install --frozen-lockfile`
3. `bunx prisma migrate deploy --schema prisma/schema.postgres.prisma`
4. `bun run build` (build-time env: only non-secret config)
5. Run: `bun run start` (web) and `bun run worker` under a process manager
   (systemd unit per process; `Restart=always`)
6. Reverse proxy (Caddy/nginx) for TLS; preserve `Host`, `X-Forwarded-Proto`
   and `X-Forwarded-For` headers — CSRF and client-IP logic depend on them.

## 9. Environment checklist (pre-launch gate)

- [ ] `DATABASE_URL` is PostgreSQL with `sslmode=require`
- [ ] `AUTH_SECRET` + `INTEGRATION_ENCRYPTION_KEY` freshly generated (never reused)
- [ ] `TRACKING_WEBHOOK_SECRET` set (webhooks otherwise disabled — 503)
- [ ] `APP_ORIGIN` matches the public https origin
- [ ] Email provider configured + `EMAIL_FROM`; `REQUIRE_EMAIL_VERIFICATION=true`
- [ ] `REDIS_URL` reachable from web and worker
- [ ] `TRUSTED_ORIGINS`/`EMBED_FRAME_ANCESTORS` set only if genuinely needed
- [ ] `/api/health` returns 200 through the public domain
- [ ] Backups + restore tested (`docs/BACKUP_AND_RESTORE.md`)
- [ ] Monitoring + log shipping wired (`docs/OPERATIONS.md`)
