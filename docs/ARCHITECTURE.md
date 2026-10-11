# StayLoop Architecture

> Actual implementation reference — describes the system as it is built, not
> as aspirational design. Last verified: Phase 7 (production hardening pass).

## 1. High-level topology

```
                    ┌──────────────────────────────────────────────┐
                    │                 Browser / SPA                │
                    │  (single-page admin app, public QR pages,    │
                    │   verify-email / forgot / reset pages)       │
                    └──────────────┬───────────────────────────────┘
                                   │ HTTPS (cookies or Bearer fallback)
                    ┌──────────────▼───────────────┐
                    │        Next.js 16 server     │
                    │  middleware.ts (request-id,  │
                    │  CORS allowlist)             │
                    │  80+ API routes (App Router) │
                    │  requireAuth → RBAC → tenant │
                    │  scoping → Zod validation    │
                    └───┬──────────┬───────────┬───┘
                        │          │           │
        ┌───────────────▼──┐  ┌────▼─────┐  ┌──▼──────────────────┐
        │ PostgreSQL (prod)│  │ Redis    │  │ Message providers   │
        │ SQLite (dev/test)│  │ (rate    │  │ WhatsApp Cloud API  │
        │ 36 Prisma models │  │ limiting)│  │ Twilio SMS          │
        └───────────────┬──┘  └──────────┘  │ EmailService: SMTP /│
                        │                   │ AWS SES / Resend /  │
                        │                   │ SendGrid / Mock     │
        ┌───────────────▼──────────┐        └──▲──────────────────┘
        │  Background worker       │           │ signed webhooks
        │  scripts/worker.ts       │───────────┘ (HMAC + replay window)
        │  campaign sends, exports │
        │  retries, dead-letter    │
        └──────────────────────────┘
```

## 2. Runtime components

| Component | Entry point | Notes |
|---|---|---|
| Web app | `bun run dev` / `bun run start` (standalone output) | Serves SPA pages + `/api/*`; fail-closed startup validation in `src/instrumentation.ts` |
| Background worker | `bun run worker` (`scripts/worker.ts`) | Polls the `BackgroundJob` table; multiple instances safe (optimistic claim); handles stale locks, token purge, export cleanup |
| Database | PostgreSQL in production; SQLite dev/test | `prisma/schema.postgres.prisma` mirrors `prisma/schema.prisma`; initial migration `prisma/migrations/0001_init` |
| Redis (optional) | `REDIS_URL` | Distributed rate limiting; without it the limiter falls back per-instance (documented limitation) |

## 3. Request lifecycle (API)

1. **Edge middleware** (`src/middleware.ts`) — assigns `x-request-id` (or
   forwards a well-formed upstream one), applies CORS: `Access-Control-*`
   only for exact origins in `TRUSTED_ORIGINS`; unknown-origin preflights get
   `403`. Never a wildcard for credentialed APIs.
2. **Security headers** (`next.config.ts`) — CSP (`default-src 'self'`,
   `object-src 'none'`, `base-uri 'self'`, `frame-ancestors` = `'self'` in
   production unless `EMBED_FRAME_ANCESTORS` is set), HSTS, nosniff,
   Referrer-Policy, Permissions-Policy.
3. **Guard layer** (`src/lib/api-helpers.ts`) — `requireAuth()`:
   CSRF (Origin/Referer allowlist + double-submit token) → session HMAC
   verification → **DB re-read of the user on every request** (suspension,
   hotel status, `tokenVersion` revocation, `mustChangePassword` scope) →
   tenant context (`hotelId` ALWAYS from the DB user record, never from the
   client). `requirePermission()` enforces the RBAC matrix.
4. **Validation** — Zod schemas in `src/lib/validation.ts`; JSON body cap 1 MB.
5. **Business logic** — domain modules (below) with transactional integrity.
6. **Errors** — centralized `serverError()`: structured
   `{error:{code,message,requestId}}`, no stacks/SQL/paths; audit + structured
   log entry with correlation id.

## 4. Domain modules (`src/lib`)

| Module | Responsibility | Integrity guarantees |
|---|---|---|
| `auth.ts` | scrypt password hashing, HMAC session tokens (7 d TTL), cookie options | `timingSafeEqual`; `tokenVersion` revocation |
| `login-security.ts` | DB-backed account lockout (5 fails → 15 m→24 h steps) + per-IP throttle | shared across instances (DB rows) |
| `csrf.ts` | Origin/Referer allowlist + double-submit cookie | constant-time compare; wired into `requireAuth` |
| `permissions.ts` | 8-role permission matrix (~40 permissions) | server-side enforcement only |
| `loyalty.ts` | ledger-based points (earn/redeem/adjust/reverse/reconcile) | atomic `increment` inside transactions; unique `idempotencyKey`; immutable ledger; balance ≡ Σ ledger |
| `coupons.ts` | validation + redemption | slot-reservation + DB unique constraints; atomic increment with rollback; P2002-safe |
| `campaigns.ts` | send pipeline: audience → consent re-read → reserve-then-send → provider; retry w/ backoff; follow-up engine (cron HMAC) | `@@unique([campaignId,customerId,channel])` + deterministic `idempotencyKey`; orphan recovery; daily/hotel + frequency caps |
| `queue.ts` + `jobs/handlers.ts` | persistent `BackgroundJob` queue: enqueue/claim/complete/fail/cancel/recover | optimistic status-checked claim; exponential backoff; dead-letter; stale-lock recovery (10 min TTL) |
| `providers/` | WhatsApp Cloud, Twilio SMS, **EmailService (SMTP/SES/Resend/SendGrid/Mock)** | retry + timeout + honest delivery statuses; credentials env-only |
| `security-tokens.ts` | email verification & password reset tokens | 256-bit random, SHA-256 hashed storage, one-time atomic consume, TTL 24 h/1 h, previous tokens invalidated |
| `auth-emails.ts` | verification/reset link emails via EmailService | links only from validated `APP_ORIGIN`; never logged in production |
| `rate-limit.ts` | distributed limiter (Redis Lua fixed-window) + in-process sliding window fallback | `429` + `Retry-After`; status surfaced at `/api/health` |
| `crypto.ts` | AES-256-GCM for integration credentials | tenant-bound AAD; tamper/cross-tenant transplant fails |
| `webhook-verify.ts` | HMAC-SHA256 + ±5 min replay window for webhooks | fail-closed when secret unset (503) |
| `audit.ts` | append-only `AuditLog` with secret scrubbing | never throws; 100+ action constants |
| `logger.ts` | structured JSON logs, key-based redaction | never logs passwords/tokens/keys |
| `env.ts` + `config.ts` | fail-closed environment/secret validation at boot | placeholder & weak-secret rejection |
| `csv-guard.ts`, `import.ts` | CSV size/row caps, RFC-4180, formula-injection neutralization, preview==commit | bounded imports |
| `qr.ts` | 32-char unpredictable QR codes | unique, tenant-scoped, rate-limited public endpoints |

## 5. Data model highlights

- 36 models; tenant root `Hotel` (31 models carry `hotelId`).
- Key uniqueness: `User.email @unique`, `Customer @@unique([hotelId,phone])`,
  `CampaignMessage @@unique([campaignId,customerId,channel])` +
  `idempotencyKey @unique`, `CouponRedemption` slot + order uniqueness,
  `LoyaltyTransaction.idempotencyKey @unique`, `BackgroundJob` indexed on
  `[status,runAt]`.
- Session auth state on `User`: `failedLoginAttempts`, `lockedUntil`,
  `mustChangePassword`, `tokenVersion`, `emailVerified`.

## 6. Background processing

- **Why**: no large sends or exports inside an HTTP request (spec §15/§19).
- **What**: `CAMPAIGN_SEND` (idempotent via reserve-then-send) and
  `CSV_EXPORT` (streamed to `var/exports/{jobId}.csv`, HMAC download token,
  24 h expiry).
- **Trigger**: send endpoint queues automatically above
  `INLINE_SEND_THRESHOLD` (default 25 recipients); export endpoint above
  `EXPORT_INLINE_MAX_ROWS` (default 5000 rows). Both return `202` + `jobId`;
  clients poll `/api/jobs/{id}` and download via
  `/api/jobs/{id}/download?token=…`.
- **Recovery**: RUNNING jobs with locks older than 10 minutes are re-queued;
  after `maxAttempts` (default 3) jobs dead-letter (`status=FAILED`,
  `lastError` preserved).

## 7. Observability

- Structured JSON logs (`logger.ts`) with `x-request-id` correlation
  (middleware) echoed through audit metadata and error responses.
- `GET /api` — unauthenticated liveness (no info).
- `GET /api/health` — readiness: database, queue, rate-limiter backend,
  email transport state, provider booleans. `503` when not ready (fail closed).
- `GET /api/super-admin/health` — operator detail (gated).
- `AuditLog` — security-relevant events incl. verification, reset, queued
  sends/exports.

## 8. Deployment artifacts

- `Dockerfile` — 3-stage (deps → builder → non-root slim runner),
  healthcheck on `/api`, standalone output.
- `docker-compose.prod.yml` — postgres + redis + one-shot `migrate`
  (`prisma migrate deploy`) + `web` + `worker`, healthchecks, volumes for
  exports, secrets only via `env_file`.
- `.github/workflows/ci.yml` — install → dependency audit → secret scan →
  typecheck → lint → tests → build → migration validation; container job with
  Trivy scan. Deployment gates on this workflow.
