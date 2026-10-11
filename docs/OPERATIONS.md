# StayLoop Operations Runbook

Day-2 operations for the production deployment. Assumes the Docker Compose
stack from `docs/DEPLOYMENT.md`.

## 1. Daily signals

| Signal | Where | Healthy |
|---|---|---|
| Liveness | `GET /api` | 200 `{"ok":true}` |
| Readiness | `GET /api/health` | 200, `database: ok`, `queue: ok` |
| Queue depth | `/api/super-admin/health` / DB | `queued` drains to 0; `failed` stays 0 |
| Error logs | container stdout (JSON) | no `level:"error"` bursts |
| Auth anomalies | AuditLog (admin UI) | lockouts/failed logins within baseline |
| Backup freshness | backup monitor | last successful backup < 26 h |

## 2. Common procedures

### Inspect queue state
```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U stayloop -d stayloop -c \
  "SELECT status, type, count(*) FROM \"BackgroundJob\" GROUP BY 1,2 ORDER BY 3 DESC;"
# Dead-letter review:
psql … -c "SELECT id,type,\"lastError\",\"updatedAt\" FROM \"BackgroundJob\" WHERE status='FAILED' ORDER BY \"updatedAt\" DESC LIMIT 20;"
```

### Re-drive dead-lettered jobs
Fix the root cause (provider outage, bad payload), then:
```sql
UPDATE "BackgroundJob" SET status='QUEUED', attempts=0, "runAt"=now(), "lastError"=NULL WHERE status='FAILED' AND id IN (…);
```
Campaign sends remain safe to re-drive (reserve-then-send idempotency).

### Rotate application secrets
Follow `docs/SECRET_ROTATION.md`; after rotating `AUTH_SECRET`, users simply
re-login (old tokens fail HMAC).

### Grant/revoke super-admin bootstrap
Bootstrap is disabled unless `ADMIN_BOOTSTRAP_SECRET` is set. Set it, run the
bootstrap once, remove it — never leave it in `.env`.

### Tail structured logs with correlation
```bash
docker compose -f docker-compose.prod.yml logs -f web | jq 'select(.event)'
# Any user-reported bug: ask for the x-request-id from the error response, then
docker compose logs web | grep '<request-id>'
```

### Manual backup (ad-hoc)
```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U stayloop -d stayloop -Fc > manual-$(date +%F).dump
```

## 3. Capacity & performance

- Watch DB connections (web × pool + worker) vs `max_connections`.
- `CampaignMessage` and `AuditLog` grow fastest; plan archiving (see
  `docs/DATABASE.md` §6) when tables exceed comfortable backup windows.
- Campaign send throughput scales linearly with worker replicas; audience
  above `INLINE_SEND_THRESHOLD` automatically queues.
- p95 API latency target < 500 ms (SQLite dev measurements: single-digit ms
  for CRUD; Postgres prod budget includes network + pool wait).

## 4. Upgrades

1. Read the release notes; note migration steps.
2. Backup (§2).
3. `docker compose -f docker-compose.prod.yml build && up -d` (migrate service
   runs first; web/worker wait for it).
4. Smoke: `/api/health`, login, one CRUD op, one queued job round-trip.
5. Keep the previous image tag ready for instant rollback.

## 5. Alerts worth configuring (minimum)

- Liveness/readiness probe failures (page)
- No successful backup in 26 h (page)
- Dead-letter count > 0 for > 30 min (ticket → page if growing)
- 5xx rate > 1% over 5 min (page)
- Disk: exports volume > 80% (ticket)

## 6. Access & escalation

- Production shell access: 2-person rule for `docker exec` into Postgres.
- Super-admin panel actions are audited; review weekly.
- Incident escalation: `docs/INCIDENT_RESPONSE.md`.
