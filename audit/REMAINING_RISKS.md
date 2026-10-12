> **Historical snapshot (2026-10-11).** For this checkout, see [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md), [REPAIR_CHANGELOG.md](REPAIR_CHANGELOG.md) and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md). Statements below describe the earlier audit, not the post-repair result.

# Remaining Risks and Limitations — StayLoop audit (2026-10-11)

## 1. Open defects
| ID | Risk | Severity | Why not fixed |
|---|---|---|---|
| FUNC-001 | Custom-role grants are never enforced | High (functional) | Needs `requirePermission` made async across ~200 call sites plus a DB-backed test. Scoped as its own change. |
| SEC-007 | Payment-link routes have no rate limit | Low | Low abuse value; the link token is high entropy. |
| SEC-008 | Bearer tokens are accepted on every route | Informational | Documented design (iframe fallback). Mitigated by the nonce CSP. |
| — | Route-level tenant isolation for ~200 handlers was NOT verified line by line | Unknown | Only the handlers listed in SECURITY_FINDINGS.md were read. See §3. |

## 2. Verification gaps (things the audit could not prove)
1. **No database-backed test ran.** Every behavioral claim for authentication lockout, MFA, RBAC enforcement,
   tenant isolation, billing, refunds, inventory, and imports is unverified by execution. The suites exist in
   `tests/` and `scripts/`, but they need a Prisma query engine and a running server.
2. **Dynamic exploitation was not performed.** Findings are from source analysis. SEC-005 (body DoS) and FIN-001
   (dropped capture) have source-level evidence and a function/wiring regression test, but no end-to-end reproduction.
3. **PostgreSQL parity not executed.** `schema.prisma` and `schema.postgres.prisma` have identical model and enum sets
   (110 / 55). Migration application to PostgreSQL 16 and `prisma migrate diff` drift checks were NOT run.
4. **Production build not verified.** `next build` fails in this sandbox on Google Fonts. It has not been shown to
   succeed on the final code.
5. **Redis-dependent behavior not tested.** Distributed rate limits, the job queue, and the worker were not exercised.
   In-process fallback behavior is unverified.
6. **Browser / UI / accessibility / responsive checks not performed.**
7. **Email, SMS, WhatsApp, Razorpay, and Stripe integrations not exercised.** No sandbox credentials were available,
   and no live calls were made (by policy). Webhook signature logic was reviewed, not run against provider fixtures.
8. **Backup encryption and restore not executed.** `scripts/restore-backup.ts` and `src/lib/saas/backup.ts`
   were not run. In test mode `backup.ts` writes a fake dump.

## 3. Coverage of the route inventory
`audit/ROUTE_INVENTORY.md` lists 202 route files from static analysis. Auth, permission, and `hotelId` *presence*
were detected automatically. Line-by-line review was done for only about 20 handlers: staff, menu item, API key,
logout, login-related helpers, the three payment routes, the Razorpay webhook, the super-admin bootstrap, the test
mock-email route, the wallet pass, and the public QR route. Everything else (for example customers, campaigns,
segments, orders, tables, inventory, billing, refunds, exports, imports, AI, and integrations) is **NOT AUDITED** at
the handler level.

## 4. Known design risks (accepted or noted)
- Session cookies are `SameSite=None; Partitioned` in production to support the embedded preview. That makes
  CSRF defenses (Origin check + double-submit) load-bearing. SEC-006 closed the one route that lacked them.
- Sessions last 7 days. Revocation is immediate through `tokenVersion`, but a stolen token is valid until it is revoked.
- Rate limits and lockout counters are per process unless `REDIS_URL` is set. `env.ts` only warns about this in production.
- The Dockerfile base image is pinned by tag (`oven/bun:1.3.14`), not by digest.
- The `.auth-secret.dev` file holds a generated dev secret in the working directory. It is gitignored, and production
  refuses to start without `AUTH_SECRET`.

## 5. Test status per file (latest run, final tree)
Source: `bun test tests/<file>` for every file, run in one loop on the branch tree after the fixes. "load error (Prisma engine)" means the module failed to import before any test ran. "connect error (no server)" means the test needed a server at `localhost:3100`, which the harness could not start. Fail counts on load-error files are bun summary artifacts, not real assertion failures.

Counts are NOT stable across runs: an earlier run on the original tree reported different fail counts for `billing-outbox` (11) and `export-quota` (0) than this run. For every non-PASS file the real result is **unknown**, not 0 failures.

| File | Exit | Pass | Fail | Cause |
|---|---|---|---|---|
| audit-2026-regressions | 0 | 13 | 0 | PASS |
| audit-fixes | 1 | 0 | 1 | load error (Prisma engine) |
| auth | 1 | 0 | 8 | connect error (no server) |
| backup-schedule | 1 | 0 | 0 | load error (Prisma engine) |
| billing-outbox | 1 | 0 | 0 | load error (Prisma engine) |
| bootstrap-atomicity | 1 | 0 | 0 | load error (Prisma engine) |
| crypto-rotation | 1 | 11 | 0 | partial: load error (Prisma engine) |
| deployment-config | 0 | 16 | 0 | PASS |
| export-quota | 1 | 0 | 7 | load error (Prisma engine) |
| lockout | 1 | 0 | 1 | connect error (no server) |
| navigation-rbac | 1 | 0 | 0 | load error (Prisma engine) |
| ops-reliability | 1 | 0 | 0 | load error (Prisma engine) |
| phase10-saas | 1 | 0 | 1 | load error (Prisma engine) |
| phase11-scheduler | 1 | 0 | 0 | load error (Prisma engine) |
| phase12-menu | 1 | 0 | 1 | connect error (no server) |
| phase13-orders | 1 | 0 | 1 | connect error (no server) |
| phase14-billing | 1 | 0 | 1 | connect error (no server) |
| phase15-retention | 1 | 0 | 1 | connect error (no server) |
| phase16-operations | 1 | 0 | 1 | connect error (no server) |
| phase17-enterprise | 1 | 0 | 1 | connect error (no server) |
| phase18-ai | 1 | 0 | 1 | connect error (no server) |
| phase64 | 1 | 0 | 1 | load error (Prisma engine) |
| phase7 | 1 | 0 | 13 | connect error (no server) |
| privacy-phone | 1 | 8 | 6 | partial: connect error (no server) |
| queue-reliability | 1 | 0 | 0 | load error (Prisma engine) |
| rbac-tenant | 1 | 0 | 13 | connect error (no server) |
| recheck-fixes | 1 | 0 | 2 | load error (Prisma engine) |
| restore-args | 1 | 8 | 0 | partial: load error (Prisma engine) |
| security-hardening | 0 | 10 | 0 | PASS |
| security | 1 | 0 | 1 | connect error (no server) |
| super-admin-platform | 1 | 0 | 0 | load error (Prisma engine) |
| unit | 1 | 0 | 0 | load error (Prisma engine) |

## 6. Limitations of this report
- The report does not declare StayLoop secure or launch-ready.
- No claim is made about the 90%+ of code that was not read or executed.
- All findings are based on the repository at commit `b398b81` plus the changes on this branch.
