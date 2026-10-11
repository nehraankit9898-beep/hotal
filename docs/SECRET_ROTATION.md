# StayLoop Secret Rotation Policy

> Trigger context: the repository previously shipped development/demo secrets
> inside source and the `.env` file. **Every value that ever appeared in a
> repository, zip archive, screenshot, or document must be treated as
> compromised** and rotated before production launch — regardless of whether
> it looks "dev-only".

## 1. Secrets inventory & rotation procedure

| Secret | Where used | Rotation procedure | Downtime |
|---|---|---|---|
| `AUTH_SECRET` | session-token HMAC; export download HMAC | Generate new → set in `.env` → rolling restart of web+worker. Old sessions fail HMAC → users re-login (fail-safe). | None (users re-authenticate) |
| `DATABASE_URL` (DB password) | Postgres auth | `ALTER USER stayloop WITH PASSWORD '…';` → update `.env`/secret manager → restart web+worker+migrate. | Seconds (rolling) |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM for integration credentials | ⚠️ Data-affecting: decrypt-then-reencrypt flow required. Generate new key → run re-encryption script (decrypt with old, encrypt with new) → swap env → restart. Until rotated, integrations must be re-entered by tenants after rotation. | None (planned window) |
| `TRACKING_WEBHOOK_SECRET` | provider engagement webhooks | Generate → update env → restart web → update the same secret in WhatsApp/Twilio webhook consoles. Webhooks reject signatures during the gap (fail-closed). | Webhook events during gap |
| `FOLLOWUP_ENGINE_SECRET` | cron HMAC for `/api/campaigns/run-engine` | Generate → env → restart web → update cron job headers. | Cron tick during gap |
| `ADMIN_BOOTSTRAP_SECRET` | one-time super-admin bootstrap | Should NOT exist in steady state. If it was ever set: rotate by replacing value or simply removing it (bootstrap disabled). | None |
| WhatsApp `WHATSAPP_TOKEN` | Meta Cloud API | Rotate in Meta developer console → env → restart web+worker. | None |
| Twilio `TWILIO_AUTH_TOKEN` | Twilio API | Rotate in Twilio console → env → restart. | None |
| Email creds (`SMTP_URL` / `RESEND_API_KEY` / `SENDGRID_API_KEY`) | EmailService | Rotate at provider → env → restart. | None |

## 2. Previously-shipped dev values (must never be reused)

These values are permanent rejects in `src/lib/config.ts`
(`FORBIDDEN_SECRET_VALUES`) and are matched by the CI secret scanner:

- `stayloop-dev-secret-change-me-in-production`
- `phase2-webhook-secret-2026`
- `stayloop_dev_webhook_secret_2026`
- any value from the demo `.env` shipped in `stayloop-final-complete*.zip`
  (`dev_auth_secret_key_at_least_32_chars_long_x9`, the demo
  `INTEGRATION_ENCRYPTION_KEY`, etc.)
- any demo account password used in development or staging

Generation standard: `openssl rand -hex 32` (or provider-native rotation),
unique per environment (dev/staging/prod never share).

## 3. Rotation cadence

| Class | Cadence |
|---|---|
| Session/HMAC secrets (`AUTH_SECRET`, webhook, engine secrets) | 90 days or immediately on staff change / suspected exposure |
| Database credentials | 90 days |
| Provider credentials | Per provider recommendation (≤ 180 days) |
| `INTEGRATION_ENCRYPTION_KEY` | Only on exposure (data-affecting rotation) |

## 4. Verification after rotation

1. `/api/health` → 200
2. Login smoke test (fresh session works)
3. Signed webhook reaches `/api/tracking/webhook` with 200
4. `bun run scripts/verify-phase7.ts` (uses AUTH_SECRET-derived HMAC)
5. Old tokens rejected (attempt an old session → 401)

## 5. Guardrails enforced by tooling

- CI secret scan blocks known legacy values and generic credential patterns.
- Startup validation rejects the legacy values, short secrets, and
  placeholders in production (fail-closed boot).
- `.gitignore` blocks real env files from VCS; only `*.example` templates are
  tracked.
