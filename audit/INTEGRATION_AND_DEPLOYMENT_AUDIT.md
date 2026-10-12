> **Historical snapshot (2026-10-11).** For this checkout, see [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md), [REPAIR_CHANGELOG.md](REPAIR_CHANGELOG.md) and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md). Statements below describe the earlier audit, not the post-repair result.

# Integration and Deployment Audit — StayLoop (2026-10-11)

Method: static reading of `Dockerfile`, `docker-compose.prod.yml`, `Caddyfile`, `.github/workflows/ci.yml`,
`.env.example`, `src/lib/env.ts`, `src/lib/config.ts`, `src/instrumentation.ts`, and `src/proxy.ts`.
Nothing was built, started, or scanned: Docker is not available in this sandbox.

## Summary
| Area | Result | Status |
|---|---|---|
| Fail-closed secrets at boot | `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY` required in production; placeholders rejected; `ADMIN_BOOTSTRAP_SECRET` ≥ 32 chars; `STAYLOOP_TEST` rejected in production; `file:` SQLite rejected in production; HTTPS `APP_ORIGIN` required. Checked in `instrumentation.ts` at boot. | PASS (static) |
| Test-mode leakage | `isTest()` now production-safe (SEC-004) | PASS |
| Web port exposure | `127.0.0.1:3000:3000` only | PASS (static) |
| Postgres / Redis exposure | Not published to host ports | PASS (static) |
| Reverse proxy | Caddy forwards only to `web:3000`; the prior `XTransformPort` SSRF-style bypass is removed | PASS (static) |
| TLS / HSTS | Caddy sets `Strict-Transport-Security max-age=63072000; includeSubDomains`, `nosniff`, Referrer-Policy | PASS (static) |
| App security headers / CSP | Nonce-based script CSP; `unsafe-eval` dev-only; `frame-ancestors` explicit in production | PASS (static) |
| Container user | Web and worker run as non-root `stayloop` | PASS (static) |
| Health checks | Web: `/api/health` (compose) and `/api/health/live` (Dockerfile); worker: heartbeat file age < 90 s | PASS (static) |
| Migrations before web start | `migrate` service with `service_completed_successfully` gate | PASS (static) |
| CI: frozen lockfile | `bun install --frozen-lockfile` | PASS (static) |
| CI: dependency audit | `npm audit --omit=dev --audit-level=high` | Ran locally: 0 vulnerabilities |
| CI: secret scan | `scan:secrets` | Ran locally: clean (tracked files) |
| CI: Trivy image scan | Configured in `ci.yml` (web and worker) | NOT RUN (no Docker) |
| CI: PostgreSQL migration + drift gate | Configured | NOT RUN (BLOCKED) |
| Production build | `next build` fails here on Google Fonts | BLOCKED (environment) |
| Backup encryption / restore drill | Encrypted `.slbkp.enc`, restore script exists | NOT RUN |
| Error monitoring / log shipping | Structured JSON logs (`logger.ts`, `serverError`); no external monitoring verified | NOT AUDITED |

## Integrations (status by provider)
| Provider | Configured via | Verified in this audit | Demo / mock / blocked |
|---|---|---|---|
| Email: SMTP / Resend / SendGrid | `EMAIL_PROVIDER`, `SMTP_URL`, `RESEND_API_KEY`, `SENDGRID_API_KEY` | Selection logic read (`src/lib/providers/email.ts`). Unconfigured production logs a warning and sends fail honestly (`UnconfiguredEmailProvider`). | Blocked: no credentials; no live send |
| Razorpay (restaurant) | Tenant integration row (encrypted) or `RAZORPAY_RESTAURANT_WEBHOOK_SECRET` | Signature, amount, and dedupe logic reviewed; FIN-001 fixed | Blocked: no sandbox |
| Razorpay / Stripe (SaaS billing) | `/api/billing/webhook/[provider]` | Signature presence noted; not reviewed in depth | Blocked |
| WhatsApp Cloud API | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`; `/api/ai/whatsapp/webhook` | Route exists; signature not verified in this pass | Blocked |
| Twilio (SMS) | `TWILIO_*` | Not reviewed | Blocked |
| Outbound webhooks | `webhooks-out.ts`, `/api/webhooks`, delivery log, replay | Replay route tenant-scoped (verified) | Not run |
| Inbound tracking webhook | `TRACKING_WEBHOOK_SECRET` (503 when unset in production) | HMAC verifier reviewed (`webhook-verify.ts`) | Not run |

## Environment variables
- `.env.example` lists 32 keys (names only were checked; no values read). Every production-mandatory key is validated at boot.
- `REDIS_URL` is optional in code but a production warning is logged when it is missing. Without it, rate limits and
  lockout counters are per instance, which weakens them proportionally to the instance count.
- `DATABASE_URL` must be PostgreSQL in production (`file:` is rejected).

## Findings

### INT-001 — Redis has no authentication in the default compose URL (Low)
- `docker-compose.prod.yml` defaults `REDIS_URL` to `redis://redis:6379` with no password. Redis is not published to the host,
  so exposure is limited to the compose network. Recommend `requirepass` (or ACLs) and a `REDIS_URL` with credentials.
- Not changed in this pass (deployment config change, needs operator review).

### INT-002 — Base images pinned by tag, not digest (Low)
- `oven/bun:1.3.14`, `postgres:16-alpine`, `redis:7-alpine`, `caddy:2-alpine`. Recommend pinning digests for reproducible,
  verifiable builds. Not changed.

### INT-003 — Production build depends on Google Fonts at build time (Low, operational)
- `src/app/layout.tsx` imports Geist and Geist Mono via `next/font/google`. Air-gapped or restricted build environments fail
  (observed here). Recommend self-hosting the fonts with `next/font/local`.

### INT-004 — Single-instance assumptions (Medium, operational)
- Without `REDIS_URL`, lockout and rate-limit state is per process (warned, not blocked, in production). The compose file
  sets `REDIS_URL` by default, so the shipped config is safe. A deployment that overrides it to empty is not.

## Not audited
- Backup encryption key handling and rotation (`docs/SECRET_ROTATION.md`, `src/lib/saas/backup.ts`).
- Restore procedure (`scripts/restore-backup.ts`): not executed.
- Log retention, monitoring, alerting, and incident runbooks (`docs/INCIDENT_RESPONSE.md`) were not read.
- `DEPLOYMENT.md` and `LAUNCH_CHECKLIST.md` were not read line by line.
