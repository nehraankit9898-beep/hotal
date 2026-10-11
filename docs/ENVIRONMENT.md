# StayLoop Environment Variables Reference

Single source of truth: `src/lib/config.ts` (core secrets) and
`src/lib/env.ts` (extended validation). Templates: `.env.example` (dev),
`.env.production.example`, `.env.test.example`.

Validation runs at process start (Next.js instrumentation). Production
**fails closed**: missing/weak/placeholder required values prevent boot. Safe
errors name the variable and the reason — values are never echoed.

## Required in production (fail closed)

| Variable | Format | Purpose |
|---|---|---|
| `AUTH_SECRET` | ≥ 32 random chars (`openssl rand -hex 32`) | HMAC signing key for session tokens; also domain-separated HMAC for export download tokens |
| `DATABASE_URL` | PostgreSQL connection string (`postgresql://…`) | Database. SQLite (`file:`) is rejected at production startup |
| `INTEGRATION_ENCRYPTION_KEY` | 64 hex chars (32 bytes) | AES-256-GCM key for integration credentials at rest |

## Required conditionally (production)

| Variable | Condition |
|---|---|
| `EMAIL_FROM` | whenever an email provider is configured |
| `APP_ORIGIN` | whenever `REQUIRE_EMAIL_VERIFICATION=true` (links must be built) |
| A real provider (`SMTP_URL` / `RESEND_API_KEY` / `SENDGRID_API_KEY`) | whenever `REQUIRE_EMAIL_VERIFICATION=true` |

## Strongly recommended (optional)

| Variable | Purpose when unset |
|---|---|
| `TRACKING_WEBHOOK_SECRET` (≥ 32 chars) | engagement webhooks stay DISABLED (503) |
| `FOLLOWUP_ENGINE_SECRET` (≥ 32 chars) | cron-triggered follow-up engine disabled |
| `REDIS_URL` (`redis://…`/`rediss://…`) | rate limiting falls back to per-instance memory |
| `ADMIN_BOOTSTRAP_SECRET` (≥ 32 chars) | super-admin bootstrap disabled entirely (recommended default) |

## Email transport (Phase 7)

| Variable | Values |
|---|---|
| `EMAIL_PROVIDER` | `auto` (default) \| `smtp` \| `resend` \| `sendgrid` \| `mock` |
| `SMTP_URL` | `smtp://user:pass@host:port` or `smtps://…`; AWS SES via its SMTP interface (`email-smtp.<region>.amazonaws.com`) is auto-detected and labeled |
| `RESEND_API_KEY` / `SENDGRID_API_KEY` | HTTPS transports |
| `EMAIL_FROM` | `"Name <addr@domain>"` or `"addr@domain"` |
| `REQUIRE_EMAIL_VERIFICATION` | `true`/`false` (default `false`) — blocks login until verified |

Without a provider: dev/test use the in-memory **mock** adapter (captured mail
readable via the test-only endpoint); production reports `unconfigured` in
`/api/health` and verification/reset emails fail honestly (never fake-sent).

## Messaging providers (WhatsApp / SMS)

| Variable | Notes |
|---|---|
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Cloud API; both required for live WhatsApp |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio SMS; all three required for live SMS |
| — | Without credentials the channel runs in clearly-labeled SIMULATION mode |

## Queue & thresholds (Phase 7)

| Variable | Default | Purpose |
|---|---|---|
| `INLINE_SEND_THRESHOLD` | `25` | campaign audiences above this are queued (HTTP 202) for the worker |
| `EXPORT_INLINE_MAX_ROWS` | `5000` | CSV exports above this row count are queued |

## Web / security headers / observability

| Variable | Default | Purpose |
|---|---|---|
| `APP_ORIGIN` / `FRONTEND_URL` | dev: `http://localhost:3000` | public origin for verification/reset/QR links |
| `TRUSTED_ORIGINS` | empty (same-origin only) | CORS allowlist for `/api/*` (exact origins; never wildcards) |
| `EMBED_FRAME_ANCESTORS` | `'self'` in production, `*` in dev | CSP frame-ancestors allowlist for trusted embedding |
| `LOG_LEVEL` | `info` (prod) | `debug\|info\|warn\|error` |
| `LOG_PRISMA_QUERIES` | unset | `1` logs every query — NEVER in production (PII) |
| `BOOKING_LINK` | unset | booking funnel URL used in campaign attribution |
| `COST_PER_MESSAGE` | unset | per-message cost for ROI analytics |
| `GATEWAY_PUBLIC_SUFFIX` | unset | preview-gateway host suffix for the CSRF host allowlist (sandbox only) |

## Dev/test-only behavior

- Dev (no secrets in `.env`): per-purpose random secrets are generated once
  and stored in `.auth-secret.dev` (gitignored) so sessions survive restarts.
- Test (`STAYLOOP_TEST=1`): deterministic per-purpose secrets derived in code;
  `.env.test.example` documents the standard test values.

## Rotation

All of the above are rotatable with zero code changes — procedure in
`docs/SECRET_ROTATION.md`.
