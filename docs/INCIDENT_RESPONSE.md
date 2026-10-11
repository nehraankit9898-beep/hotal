# StayLoop Incident Response Plan

Severity model, on-call actions, and communication templates. This runbook
describes the OPERATIONAL response only — legal counsel decides any external
notification duties (GDPR Art. 33/34, DPDP, contract terms).

## 1. Severity classification

| Sev | Definition | Examples | Response |
|---|---|---|---|
| SEV-1 | Data breach, cross-tenant exposure, full outage | tenant isolation bug, DB compromised, region down | page immediately, incident commander, all-hands comms |
| SEV-2 | Auth bypass candidates, broken core feature, queue stalled | login broken, sends dead-lettering en masse | page within 15 min |
| SEV-3 | Degradation with workaround | Redis down (fallback active), one provider failing | same business day |
| SEV-4 | Cosmetic/logging noise | missing correlation id in one endpoint | backlog |

## 2. First 30 minutes (any SEV-1/2)

1. **Declare** — open an incident channel + timeline doc; name an incident
   commander (IC) and a scribe. IC owns decisions; scribe keeps the log.
2. **Contain** — prefer reversible actions first:
   - Suspected auth compromise: rotate `AUTH_SECRET` (invalidates ALL
     sessions — see `docs/SECRET_ROTATION.md`).
   - Suspected tenant-isolation bug: take affected routes offline
     (`docker compose stop web`) — availability < confidentiality.
   - Runaway automation/campaigns: `UPDATE "BackgroundJob" SET status='CANCELLED' WHERE status='QUEUED';`
     then stop the worker.
   - Bad deploy: rollback image (`docs/DEPLOYMENT.md` §7).
3. **Assess** — scope: which tenants/users, what data, what timeline. Pull
   AuditLog + structured logs (correlate via `x-request-id`).
4. **Preserve evidence** — snapshot DB + logs BEFORE mutating state further;
   copy to the incident channel (write-once storage if available).

## 3. Playbooks by incident family

### IR-1 · Suspected cross-tenant data exposure
1. Stop web (containment above). Snapshot DB.
2. Query the audit trail for the suspect identifiers to enumerate affected
   tenants precisely.
3. Patch → add a regression test at the exact route/layer
   (`tests/rbac-tenant.test.ts` pattern) → deploy.
4. Notify affected tenants per counsel; document IOCs and the fix.

### IR-2 · Credential/secret compromise
1. Rotate the affected secret(s) immediately (`docs/SECRET_ROTATION.md`).
2. `AUTH_SECRET` rotation logs out every user (fail-safe posture).
3. If integration credentials (WhatsApp/Twilio/email) leaked: rotate at the
   provider AND locally; check provider logs for abuse; audit
   `Integration`-related events.

### IR-3 · Account takeover pattern
1. Check `AuthAttempt` for bursts; confirm lockout thresholds behaved.
2. Force global logout for affected users: `tokenVersion++` per user.
3. Require password reset; consider temporarily enabling
   `REQUIRE_EMAIL_VERIFICATION` if it was off.

### IR-4 · Data corruption / bad migration
1. Stop web+worker. Snapshot current state (forensics).
2. Restore the pre-migration backup; replay WAL to the last good state.
3. Re-apply migrations in a reviewed, staging-tested order; verify with
   `scripts/verify-phase7.ts` + smoke suite before reopening.

### IR-5 · Abusive traffic (scraping, OTP/QR abuse)
1. Confirm rate limiter state in `/api/health` (`rateLimiter`).
2. Tighten limits (env thresholds), enable Redis if not already, and block at
   the edge (WAF/IP allowlists) — never by weakening auth logic.

## 4. Communication

- Internal: every 30 min (SEV-1) / 2 h (SEV-2) status in the incident channel:
  current state → impact → next action → owner.
- Customers (only with legal sign-off for data incidents): what happened,
  what data, what we did, what they should do (e.g. password reset link),
  contact channel. Never speculate; timestamps in UTC.

## 5. Post-incident (within 5 business days)

1. Blameless postmortem: timeline, root cause (5-whys), blast radius, cost.
2. Action items with owners and due dates; every item lands as either a code
   change WITH a regression test or a runbook update.
3. Update severity thresholds/detection if the incident was found by a user.
4. File the report in `reports/` and link it from the ops index.
