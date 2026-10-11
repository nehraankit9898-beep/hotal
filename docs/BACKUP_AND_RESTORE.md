# StayLoop Backup & Restore

> These procedures are scripted against PostgreSQL 16 (the production engine).
> Schedule and verify them BEFORE launch — an untested backup is not a backup.

## 1. What to back up

| Asset | Tool | Frequency | Retention |
|---|---|---|---|
| PostgreSQL cluster | `pg_dump` (custom format) + WAL archiving | Nightly full; continuous WAL | 30 daily / 12 monthly |
| `var/exports/` | filesystem sync | Not backed up (regenerable; files expire in 24 h) | — |
| `.env` secrets | your secret manager (Vault/SSM/1Password) | On change | Per provider policy |
| Container images | registry | Per release | Last 5 |

The application tier is stateless — only PostgreSQL and the exports volume
carry state, and exports are disposable.

## 2. Automated nightly backup (logical)

`/etc/cron.d/stayloop-backup` (host or sidecar "dbbackup" service):

```bash
0 2 * * * root  docker compose -f /srv/stayloop/docker-compose.prod.yml \
  exec -T postgres pg_dump -U stayloop -d stayloop -Fc \
  | gpg --batch --yes --encrypt -r ops@yourdomain.com \
  > /backups/stayloop-$(date +\%F).dump.gpg \
  && find /backups -name 'stayloop-*.dump.gpg' -mtime +30 -delete
```

Requirements met by this pattern: automated, encrypted at rest (GPG or
equivalent KMS envelope), retention pruning, offsite copy (sync `/backups`
to object storage with versioning):

```bash
0 3 * * * root rclone sync /backups remote:stayloop-backups --backup-dir remote:stayloop-backups/$(date +\%F)
```

## 3. WAL archiving (point-in-time recovery)

In the Postgres container env / `postgresql.conf`:

```
archive_mode = on
archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
wal_level = replica
```

Ship `/wal_archive` offsite continuously (rclone/rsync cron every 5 min).
Combined with nightly base backups this gives **RPO ≤ 5 minutes**.

## 4. Restore procedure (runbook)

```bash
# 0. Stop writers to avoid split-brain during restore
docker compose -f docker-compose.prod.yml stop web worker

# 1. Restore the base backup into a FRESH database (never in-place)
dropdb -h localhost -U postgres --if-exists stayloop_restored
pg_restore -h localhost -U postgres -d stayloop_restored --no-owner --role=stayloop \
  /backups/stayloop-YYYY-MM-DD.dump

# 1b. (PITR) instead of 1: replay WAL from archive up to the target timestamp
#     using pg_ctl promote / recovery_target_time on the restored cluster.

# 2. Sanity checks
psql -h localhost -U stayloop -d stayloop_restored -c \
  "SELECT count(*) FROM Hotel; SELECT count(*) FROM BackgroundJob WHERE status='FAILED';"
bun run scripts/verify-phase7.ts            # queue round-trip against restored DB

# 3. Swap over (blue/green or rename)
docker compose -f docker-compose.prod.yml up -d web worker
curl -fsS https://your-domain/api/health    # expect 200 {"status":"ok"}
```

## 5. Restore testing (mandatory)

- **Quarterly**: restore the latest backup into a scratch instance and run the
  verification above + login smoke test. Record the result in the ops log.
- **After every major release**: same drill on staging.
- Track: backup duration, restore duration, checksum failures, alert gaps.

## 6. Alerting

- Backup cron exits non-zero → alert (no successful backup in 26 h = incident).
- WAL archive lag > 15 min → alert.
- Object-storage sync failures → alert.

## 7. Related

- `docs/DISASTER_RECOVERY.md` — full DR scenarios, RTO/RPO targets, failover.
- `docs/DEPLOYMENT.md` §4 — migration safety around restore+rollforward.


---

## In-app encrypted backups (Phase 10 §16 — updated in this release)

In addition to the external pg_dump pipeline above, the platform ships an
in-app encrypted backup system (Super Admin UI → Backups & DR):

- Executed **on the worker** container (`pg_dump --format=custom`).
- Credentials are passed to pg_dump via environment variables
  (PGHOST/PGPORT/PGUSER/PGPASSWORD) — never command-line arguments, never
  logged, never included in API responses or audit records.
- Archives are AES-256-GCM encrypted, **streaming** (large databases do not
  buffer in memory), with format V2 headers that embed a key id for
  encryption-key rotation support (`INTEGRATION_ENCRYPTION_PREVIOUS_KEYS`).
- Verification (`?verify=1` / "Verify last") performs a REAL decryption pass
  (GCM auth tag checked) plus a whole-file checksum comparison.
- Manual triggers create a PENDING record that the worker claims atomically
  and processes within seconds; scheduled backups follow the configured
  interval; retention prunes old archives and their records.
- Stale RUNNING records (crashed worker) are failed by a recovery sweep.

Restore a single archive into a disposable database:

```bash
docker compose -f docker-compose.prod.yml exec -T -w /app worker \
  bun run scripts/restore-backup.ts /app/var/backups/<archive>.slbkp.enc \
  --target "postgresql://user:pass@host:5432/restore_test"
```

The script decrypts (streaming), `pg_restore --clean --if-exists` into the
target, prints row counts for verification, and cleans up the temp dump.
**Never restore directly into the production database** — verify on a
disposable target first, then follow the cutover runbook in
`docs/DISASTER_RECOVERY.md`.
