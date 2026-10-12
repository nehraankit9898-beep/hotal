> **Historical snapshot (2026-10-11).** For this checkout, see [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md), [REPAIR_CHANGELOG.md](REPAIR_CHANGELOG.md) and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md). Statements below describe the earlier audit, not the post-repair result.

# Production Readiness and Release Verdict — StayLoop (2026-10-11)

**Verdict: StayLoop is NOT ready for real customers based on this audit.** The fixes above remove several confirmed
defects, but most modules were not executed, and the database-backed suite could not run in this environment.

Scale: **VERIFIED PASS** requires that the module's defined tests executed and passed with adequate coverage. None of the
modules below meets that bar in this audit. A pass on the static checks (typecheck, lint, dependency audit, secret scan) does
not establish that the application is secure.

| Area | Verdict | Basis |
|---|---|---|
| Feature completeness | **PASS WITH KNOWN RISKS** | 202 API routes and 8 pages exist in source, and feature areas are mapped (`FEATURE_INVENTORY.md`). Behavior was not run. Custom roles are known not to work (FUNC-001), so that module is FAIL. |
| Functional correctness | **FAIL** | FUNC-001 confirmed (custom-role grants never enforced). No end-to-end test ran, so other functionality is unverified. |
| Authentication security | **PASS WITH KNOWN RISKS** | Strong design, reviewed statically: scrypt hashing, HMAC tokens, DB-backed revocation, lockout, MFA with policy and disable-by-code, CSRF. SEC-006 fixed. Nothing run dynamically. |
| Superadmin security | **PASS WITH KNOWN RISKS** | Guard reviewed (SEC-002 fixed); bootstrap is fail-closed and one-time. Impersonation/support semantics NOT verified. |
| Admin and custom-role security | **FAIL** | SEC-001 (admin could lock out the owner) fixed, but custom-role permission handling is broken (FUNC-001). Owner, admin, and staff matrix derived from source only. |
| Tenant and branch isolation | **NOT AUDITED** | Sampled handlers are scoped correctly (staff, menu item, API key, webhook replay, customer helper). Two-tenant dynamic tests were not run. ~180 handlers unreviewed. |
| Financial correctness | **FAIL** | FIN-001 (payment dropped on transient error) fixed. Known money-unit and Float issues (DB-001, DB-002) and unrounded coupon display path remain. Refunds, cash sessions, invoices not verified. |
| Customer-data protection | **NOT AUDITED** | Consent, opt-out, import/export, deletion not reviewed; no PII leakage test run. |
| API security | **PASS WITH KNOWN RISKS** | Auth/CSRF pattern consistent across routes (automated); body cap fixed (SEC-005); payment-link routes unthrottled (SEC-007); no fuzzing. |
| Database integrity | **PASS WITH KNOWN RISKS** | Model parity by name, integer minor-unit money on bills, unique per-tenant numbers, no destructive forward migrations. Migrations not applied; drift gate not run. |
| UI and accessibility | **NOT AUDITED** | No browser available. |
| External integrations | **BLOCKED** | No sandbox credentials. Webhook signatures reviewed statically only. |
| Deployment readiness | **PASS WITH KNOWN RISKS** | Compose and Caddy config are hardened (loopback binding, no published DB/Redis, fail-closed env). Docker build, Trivy, and the production build were NOT run (BLOCKED). |
| Backup and recovery readiness | **NOT AUDITED** | Encrypted backup code exists; no restore drill was run. Test mode writes a fake dump. |

## Blocking items before any real-customer launch
1. Fix FUNC-001 or hide custom roles from the UI and document them as unavailable.
2. Run the full suite (`bun run test`) on a machine with working Prisma engines and Redis. Every failing test must be fixed or documented.
3. Add DB-backed two-tenant isolation tests for every tenant-owned route group (see `ROLE_PERMISSION_MATRIX.md` for the permission set).
4. Run the PostgreSQL migration and drift gate, then a restore rehearsal from an encrypted backup.
5. Make a production build succeed (self-host fonts, INT-003) and build the Docker images with a Trivy scan.
6. Review the customer lifecycle (consent withdrawal, suppression before send, export/deletion) against a mock provider.
7. Decide the money-unit policy and plan the Float to Int migration (DB-001) before any revenue report is trusted.
8. Confirm superadmin support/impersonation is time-limited, visibly marked, and audited.

## Launch gates from `LAUNCH_CHECKLIST.md`
Not evaluated item by item in this pass. Treat the checklist as an operator task, not as a result of this audit.
