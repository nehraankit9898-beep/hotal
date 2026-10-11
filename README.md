# StayLoop — Hotel & Restaurant Customer Retention & Loyalty SaaS

StayLoop helps hotels and restaurants increase repeat customers by storing
customer visits (room stays + restaurant visits), recording marketing consent,
automatically segmenting customers, running consent-first campaigns, automating
follow-ups, scoring leads from engagement signals, and giving one super admin a
single dashboard to manage many hotel tenants.

Core modules: CRM & RFM segmentation · loyalty engine & QR feedback loops ·
marketing automation & journeys · menu, tables & online ordering · POS & GST
billing · reservations & inventory · referrals, promotions & owner reports ·
multi-tenant SaaS billing (Razorpay/Stripe/Manual) · super-admin control centre
with MFA, audit trail & security centre.

---

## Tech Stack

| Layer    | Technology                                                            |
|----------|-----------------------------------------------------------------------|
| Frontend | React 19 + TypeScript + Next.js 16 (App Router)                       |
| UI       | Tailwind CSS 4 + shadcn/ui + Recharts + Framer Motion                 |
| Backend  | Next.js API Routes (REST) + Zod validation + BullMQ-style job queue   |
| Database | Prisma ORM — SQLite for dev, PostgreSQL 16 for production             |
| Auth     | Custom sessions: scrypt hashing + HMAC-SHA256 tokens, httpOnly cookies|
| Runtime  | Bun (dev, test, worker) / Node-compatible production standalone build |

---

## Quick Start (Local Development)

Requirements: **Bun ≥ 1.3** (https://bun.sh) and SQLite (built in).

```bash
bun install

# 1. Configure environment
cp .env.example .env        # dev works with defaults; no secrets required

# 2. Create + seed the demo database (one time)
bun run dev:setup           # prisma db push + demo seed data

# 3. Start the dev server
bun run dev                 # http://localhost:3000

# Optional: run the background worker (campaigns, exports, emails)
bun run worker
```

The first super admin is created with:

```bash
ADMIN_BOOTSTRAP_SECRET=<strong-secret> bun run bootstrap:admin
```

> The repository ships **no demo database and no demo passwords** — all demo
> data is reproducible via `bun run dev:setup` / `bun run seed`.

---

## Scripts

| Command                        | What it does                                        |
|--------------------------------|-----------------------------------------------------|
| `bun run dev`                  | Dev server on port 3000                             |
| `bun run build`                | Production standalone build                         |
| `bun run start`                | Start the standalone production server              |
| `bun run typecheck`            | TypeScript check (no emit)                          |
| `bun run lint`                 | ESLint                                              |
| `bun run test`                 | Full test suite (security, RBAC, phases 1–18)       |
| `bun run db:generate`          | Generate Prisma client (dev SQLite schema)          |
| `bun run db:migrate:deploy`    | Apply PostgreSQL migrations (production schema)     |
| `bun run seed`                 | Seed demo data (phases 1–6.3)                       |
| `bun run bootstrap:admin`      | Create the first super admin                        |
| `bun run worker`               | Background job worker                               |
| `bun run scan:secrets`         | Scan the repo for accidentally committed secrets    |
| `bun run restore:backup`       | Restore an encrypted `.slbkp.enc` backup            |

---

## Production Deployment

Production runs on **PostgreSQL 16 + Redis 7** behind Caddy (automatic HTTPS),
deployed with Docker Compose on an Ubuntu VPS.

👉 Follow **[`DEPLOYMENT.md`](DEPLOYMENT.md)** — beginner-friendly, verified
copy-paste steps for a fresh VPS (Docker install, `.env`, migrations, web +
worker + Caddy, health checks, backups).

Before going live with real customers, walk through
**[`LAUNCH_CHECKLIST.md`](LAUNCH_CHECKLIST.md)** (demo/staging vs real-customer
gates).

### Environment

`.env.example` documents every variable. The fail-closed production minimum:

- `DATABASE_URL` — PostgreSQL connection string
- `AUTH_SECRET` — session signing key (`openssl rand -hex 32`, ≥ 32 chars)
- `INTEGRATION_ENCRYPTION_KEY` — AES-256-GCM key (64 hex chars)
- `APP_ORIGIN`, `DOMAIN`, `ACME_EMAIL` — for Caddy TLS
- `REDIS_URL` — distributed rate limiting + job queue

Full reference: [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

---

## Project Structure

```
src/
  app/          Next.js App Router (API routes + pages)
  components/   app/ (product UI), public/ (QR/menu pages), ui/ (shadcn)
  lib/          domain logic: auth, billing, loyalty, campaigns, SaaS, …
  hooks/        shared React hooks
prisma/         schema.prisma (SQLite dev) + schema.postgres.prisma + migrations
scripts/        seed, bootstrap, worker, test runners, ops utilities
tests/          bun test suites (auth, RBAC, billing, phases 1–18 regressions)
docs/           architecture, security, ops runbooks (backup, incidents, DR)
.github/        CI: typecheck, lint, tests, PG migrations, Docker, Trivy
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design & data model
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model & controls
- [`docs/BACKUP_AND_RESTORE.md`](docs/BACKUP_AND_RESTORE.md) ·
  [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md) — data safety
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) ·
  [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md) — runbooks
- [`docs/SECRET_ROTATION.md`](docs/SECRET_ROTATION.md) — key rotation policy
- [`docs/DATABASE.md`](docs/DATABASE.md) — SQLite → PostgreSQL details
