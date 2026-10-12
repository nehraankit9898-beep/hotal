# Repair changelog — 2026-10-12

| Finding | Root cause and smallest change | Regression / result | Uncertainty |
|---|---|---|---|
| FUNC-001 / ROLE-002 | `requireAuth` now resolves permissions from active same-hotel role assignments per request; `requirePermission` consults the trusted set; superadmin and high-risk permissions excluded even from old persisted roles. Add role PATCH, assignment DELETE, protect role listing, validate target/assignment. | `bun test tests/custom-role-resolution.test.ts` 3 PASS (mocked delegate); `tests/custom-role-api.test.ts` authored, BLOCKED. | DB / real route authorization NOT VERIFIED. No per-route UI review. |
| SEC-007 | Shared payment link limit on public GET/checkout/verify, no client-provided permission inputs. | `bun test tests/payment-link-limit.test.ts` 1 PASS. | Redis multi-instance NOT VERIFIED. |
| BUILD-001 | Replace Google-hosted `next/font/google` with local OFL licensed Geist variable fonts, preserving CSS variables. | `bun run build` now compiles, fails typecheck due missing Prisma client. | Full production build BLOCKED. |
| Test registration | Add 3 `.test.ts` files to `scripts/run-tests.ts` manifest; runner guard will fail if unregistered. | `bun run test` blocked at DB push. | Full suite not executed. |

`git diff --check` PASS; no migration, production data, secret, provider call, real marketing message, or payment created. Additional risks and reproduction in `REMAINING_BLOCKERS.md`.

## Exact changed/new files

- `audit/EXECUTIVE_SUMMARY.md`
- `audit/FEATURE_INVENTORY.md`
- `audit/INTEGRATION_AND_DEPLOYMENT_AUDIT.md`
- `audit/PRODUCTION_READINESS.md`
- `audit/REMAINING_RISKS.md`
- `audit/ROLE_PERMISSION_MATRIX.md`
- `audit/SECURITY_FINDINGS.md`
- `scripts/run-tests.ts`
- `src/app/api/custom-roles/[id]/assign/route.ts`
- `src/app/api/custom-roles/route.ts`
- `src/app/api/pay/[token]/checkout/route.ts`
- `src/app/api/pay/[token]/route.ts`
- `src/app/api/pay/[token]/verify/route.ts`
- `src/app/layout.tsx`
- `src/lib/api-helpers.ts`
- `src/lib/custom-roles.ts`
- `src/lib/permissions.ts`
- `audit/AUTHORIZATION_MATRIX.md`
- `audit/DATABASE_AND_MIGRATIONS.md`
- `audit/DEPENDENCY_AND_DEPLOYMENT.md`
- `audit/FINAL_VERIFICATION_REPORT.md`
- `audit/INITIAL_FAILURES.md`
- `audit/MASTER_BASELINE.md`
- `audit/PAYMENT_AND_FINANCIAL_AUDIT.md`
- `audit/REMAINING_BLOCKERS.md`
- `audit/REPAIR_CHANGELOG.md`
- `audit/TENANT_ISOLATION_TESTS.md`
- `audit/UI_AND_E2E_RESULTS.md`
- `src/app/api/custom-roles/[id]/route.ts`
- `src/app/fonts/Geist-Variable.woff2`
- `src/app/fonts/GeistMono-Variable.woff2`
- `src/app/fonts/LICENSE.txt`
- `src/lib/payment-link-limit.ts`
- `tests/custom-role-api.test.ts`
- `tests/custom-role-resolution.test.ts`
- `tests/payment-link-limit.test.ts`
