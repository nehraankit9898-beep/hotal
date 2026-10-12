# Remaining blockers and risks — 2026-10-12

1. **High / deployment — Prisma engine unavailable**: approved egress/mirror needed for `binaries.prisma.sh` to generate Prisma client, typecheck, build, create disposable DB, run integration/tenant/auth tests and migrate/restore. Do not substitute fake client or mark tests PASS. `bunx prisma generate --schema prisma/schema.prisma` fails downloading pinned schema engine. On a controlled CI runner with network and PostgreSQL 16, rerun commands in `DATABASE_AND_MIGRATIONS.md`.
2. **High / financial — PAY-001**: `src/app/api/pay/[token]/verify/route.ts` swallows link update failure after capture; payment reconciliation under failure/duplicate callbacks untested. Fix transaction/retry semantics and verify sandbox before accepting real payments.
3. **High / dependencies — DEP-002**: `bun audit --audit-level=high` returned 26 high advisories. Triage reachable runtime paths and compatible fixes; do not bulk-upgrade blindly.
4. **High / authorization verification — FUNC-001**: only mocked-delegate tests ran. Execute `tests/custom-role-api.test.ts` and whole `bun run test` against disposable DB; check transaction behavior and branch memberships under concurrency. No browser admin/owner test.
5. **High / coverage**: tenant-owned models, payment refunds, privacy exports, campaign consent, scheduled jobs, support impersonation, MFA recovery, backup/restore and external providers NOT TESTED. Prior historical source audits are not live assurance.
6. **Operational**: Redis required for shared limits at scale; checkout rate limiter falls back to per-process without it. No distributed test. No Docker image scan, live health check, Pg restore or production TLS check.

Decision: **NOT READY**. No production deployment or provider verification may be claimed. Explicit owner/security review required after outstanding checks pass.
