# Risk Register — StayLoop (2026-10-11)

Likelihood (L) and impact (I) are judgments from the static evidence. "Evidence" points to the document with the detail.

| ID | Risk | L | I | Severity | Evidence | Status |
|---|---|---|---|---|---|---|
| R-01 | Admin locks out or takes over the HOTEL_OWNER account | Medium | High | **High** | SECURITY_FINDINGS SEC-001 | Fixed (commit on branch) |
| R-02 | Captured restaurant payment never allocated after a transient DB error | Medium | High | **High** | SECURITY_FINDINGS FIN-001 | Fixed |
| R-03 | Custom-role permissions silently ineffective; owners believe access was granted | High | Medium | **High (functional)** | FUNCTIONAL_BUGS FUNC-001 | Open (scoped change) |
| R-04 | Forced logout of any signed-in user from a third-party page | Medium | Medium | Medium | SEC-006 | Fixed |
| R-05 | Demoted superadmin keeps access until token expiry | Low | High | Medium | SEC-002 | Fixed |
| R-06 | Memory exhaustion via large chunked request bodies | Medium | Medium | Medium | SEC-005 (source only) | Fixed (unit-tested; not load-tested) |
| R-07 | Test-only endpoint or behaviour enabled in production | Low | High | Low (startup-blocked) | SEC-004 | Fixed (defense in depth) |
| R-08 | Unmetered abuse of payment-link checkout (gateway order creation) | Low | Low | Low | SEC-007 | Open |
| R-09 | Stolen bearer token usable like a cookie | Low | Medium | Informational | SEC-008 | Accepted |
| R-10 | Tenant isolation defect in one of ~180 unreviewed handlers | Unknown | High | **Unknown (not verified)** | REMAINING_RISKS §3 | Open — needs DB-backed two-tenant tests |
| R-11 | Money computed in Float or mixed units (paise vs rupees) | Medium | Medium | Medium | DATABASE_AND_MIGRATION_AUDIT DB-001/002 | Open |
| R-12 | Migration or schema drift between SQLite and PostgreSQL in production | Low | High | Medium (unverified) | DATABASE audit; CI gate exists | Open — gate not run here |
| R-13 | Production build cannot be reproduced in a restricted network | Medium | Low | Low | INTEGRATION INT-003 | Open |
| R-14 | Rate limits and lockouts weakened without Redis | Medium | Medium | Medium (operator-dependent) | INTEGRATION INT-004 | Warned at boot |
| R-15 | Security docs wrongly state MFA is absent | Medium | Low | Low | FUNCTIONAL_BUGS DOC-001 | Open |
| R-16 | Backup restore never rehearsed | Medium | High | **High (unverified)** | REMAINING_RISKS §2.8 | Open |
| R-17 | Customer data (consent, export, deletion) not verified end to end | Unknown | High | **Unknown** | FEATURE_INVENTORY | Open |
| R-18 | Redis without authentication if the compose network is shared | Low | Medium | Low | INTEGRATION INT-001 | Open |
| R-19 | Dependency vulnerabilities in dev-only packages | — | — | — | `npm audit --omit=dev` = 0; dev deps not audited | Partially covered |

## Summary counts
- High (confirmed): R-01, R-02, R-03 (functional) — R-01 and R-02 fixed; R-03 open.
- High (unverified): R-10, R-16, R-17 — cannot be assessed without DB-backed tests.
- Medium and below: see table.
