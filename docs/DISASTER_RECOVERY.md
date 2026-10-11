# StayLoop Disaster Recovery Plan

Owner: platform on-call. Review cadence: quarterly and after every incident.

## 1. Objectives

| Metric | Target | Notes |
|---|---|---|
| RPO (data loss tolerance) | ≤ 5 min | nightly base backup + continuous WAL shipping (`docs/BACKUP_AND_RESTORE.md`) |
| RTO (service restoration) | ≤ 60 min | scripted restore + container redeploy |
| Single-region failure | regional failover to standby infra-as-code | Terraform/compose stack is reproducible from repo + backups |

## 2. Failure scenarios & playbooks

### DR-1 · Web instance crash
Detection: `/api` liveness probe failing; orchestrator restarts container.
Action: automatic (`restart: unless-stopped`). Verify `/api/health` 200 within
2 min. Sessions survive (HMAC tokens + DB state) — no user impact.

### DR-2 · Worker crash / stalled queue
Detection: `/api/health` still ok but `queued` count grows and no job
transitions for > 10 min; `BackgroundJob` RUNNING rows older than the 10-min
lock TTL are auto-recovered into the queue.
Action: restart worker (`docker compose restart worker`). Stale locks are
re-claimed automatically; completed work is never duplicated (reserve-then-send
+ idempotency keys).

### DR-3 · Redis outage
Impact: rate limiter falls back to per-instance memory (auth throttling stays
authoritative via the database). `/api/health` shows `rateLimiter: "error"`.
Action: restore Redis (volume persists with `--appendonly yes`); no data loss
(Redis holds only counters). Accept degraded multi-instance limiting meanwhile.

### DR-4 · Email provider outage
Impact: verification/reset emails fail with retries (3 attempts, backoff);
`/api/health` still ok; registration continues, admins can trigger resend.
Action: check provider status page; switch `EMAIL_PROVIDER` (e.g. resend →
smtp) and restart web+worker. Failed verification sends are audited; use
`POST /api/auth/resend-verification`.

### DR-5 · PostgreSQL instance loss
Action: provision fresh Postgres → restore latest base backup + WAL replay
(runbook `docs/BACKUP_AND_RESTORE.md` §4) → run `prisma migrate deploy` (must
be a no-op) → verify with `scripts/verify-phase7.ts` → repoint `DATABASE_URL`
→ start web+worker. RTO driven by restore time; drill quarterly.

### DR-6 · Bad deploy / failed migration
Action: rollback image tag (blue/green). If a migration is mid-flight and
destructive: restore pre-migration backup (Prisma migrations are not
auto-reversible — that is why destructive migrations require a reviewed
backup gate). Verify with the health + smoke suite.

### DR-7 · Region/datacenter loss
Action: stand up the stack in the secondary region from this repo (compose
file + env template), restore backups into the new Postgres, repoint DNS.
The stack is intentionally self-contained (no in-region hard dependencies
besides providers).

### DR-8 · Security incident (ransomware/data compromise)
Action: invoke `docs/INCIDENT_RESPONSE.md` FIRST (containment, revocation via
`tokenVersion`, credential rotation `docs/SECRET_ROTATION.md`), then restore
from a pre-incident verified backup.

## 3. Recovery verification checklist (after ANY DR event)

- [ ] `GET /api` → `{"ok":true}`
- [ ] `GET /api/health` → 200, `database: ok`, `queue: ok`
- [ ] Login works for a seeded admin (cookie + CSRF issuance)
- [ ] `bun run scripts/verify-phase7.ts` → PASS
- [ ] Background job completes end-to-end (enqueue → COMPLETED)
- [ ] Audit log write path verified (perform any audited action)
- [ ] Announce recovery + record timeline in the incident report

## 4. Dependency map (external)

| Dependency | Failure mode | Mitigation |
|---|---|---|
| WhatsApp Cloud API / Twilio | provider outage | SIMULATION-mode labeling is honest; sends fail with retries + dead-letter, never fabricated success |
| Email provider | outage/bounce | retries, provider switch, mock capture for diagnostics |
| Docker registry | pull failure | pin + cache images on hosts |

## 5. Drill schedule

| Drill | Frequency |
|---|---|
| Restore latest backup to scratch + smoke suite | Quarterly |
| Worker kill → stale-lock recovery observation | Monthly (staging) |
| Region-failover tabletop | Semi-annual |
