# Fix Log — StayLoop audit (2026-10-11)

Branch: `arena/4731a2f4-hotal`. Every fix is a small, root-cause change. No feature was removed, no check was weakened,
and no test was suppressed.

| Finding | Files changed | Change | Regression test | Result |
|---|---|---|---|---|
| SEC-001 | `src/lib/staff-guards.ts` (new), `src/app/api/staff/[id]/route.ts` | Pure rank guard `canActOnStaffTarget`; route returns 403 for an admin acting on the owner, before any mutation | `audit-2026-regressions` › SEC-001 (4 tests) | Fails on original (wiring test); passes with fix |
| SEC-002 | `src/lib/api-helpers.ts` (`requireSuperAdminSession`) | Select DB `role`; require `SUPER_ADMIN` in the database, not only in the token | Source-level only (behavioral test BLOCKED) | Code review; DB test pending |
| SEC-004 | `src/lib/config.ts` (`isTest`) | `isTest()` is false when `isProduction()` | `audit-2026-regressions` › SEC-004 | Fails on original; passes with fix |
| SEC-005 | `src/lib/body.ts` (new), `src/lib/api-helpers.ts` (`readJson` now aliases `readJsonCapped`) | Byte-counted streaming read with 1 MB cap; declared oversize rejected early; malformed JSON → null | `audit-2026-regressions` › SEC-005 (5 tests) | Passes (new module); original defect shown by source reading |
| SEC-006 | `src/app/api/auth/logout/route.ts` | `assertCsrf` before revoking sessions; client logout is best-effort, so no UX regression | `audit-2026-regressions` › SEC-006 (2 tests) | Passes |
| FIN-001 | `src/app/api/webhooks/razorpay-restaurant/route.ts` | Wrap `recordGatewayCapture`; on throw, delete the dedupe row and re-throw so the provider retries | `audit-2026-regressions` › FIN-001 (1 static test) | Fails on original; passes with fix |
| (tooling) | `audit/tools/generate_inventory.py` (new) | Generates `ROUTE_INVENTORY.md` and `ROLE_PERMISSION_MATRIX.md` from source | Run and checked by hand (202 routes, 11 roles, 88 permissions) | — |

## Test-file corrections made during the work
- The first regression file failed typecheck: `process.env.NODE_ENV` is read-only in TypeScript. Fixed with a typed cast in the test only; no production code changed.
- A first version of `readJson` also rejected JSON arrays. That would have changed behavior for any route that accepts an array, so it was reverted before commit.
- `src/lib/permissions.ts` got a stray one-line change while the helper was being moved; reverted with `git checkout`.
- Prettier: new files and `api-helpers.ts` (clean before the audit) were formatted. `staff/[id]/route.ts` and `razorpay-restaurant/route.ts` were already unformatted on `main`, so they were left alone to keep the diff focused.

## Verification after the fixes
| Check | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run scan:secrets` | exit 0 (tracked files) |
| `bun test tests/audit-2026-regressions.test.ts` | 13 pass, 0 fail |
| `bun test tests/deployment-config.test.ts` | 16 pass, 0 fail (unchanged) |
| `bun test tests/security-hardening.test.ts` | 10 pass, 0 fail (unchanged) |
| Fail-on-original check | 3 regression tests fail on original code, pass with fixes |

## Not fixed (see REMAINING_RISKS.md)
FUNC-001 (custom roles), SEC-007 (rate limits on payment-link routes), DB-001/DB-002 (Float and mixed money units), INT-001 to INT-004, DOC-001 (documentation).

## Rollback
Each fix is independent. To revert one, `git revert` the relevant hunk (the files are listed above). Nothing in this set changes the database schema or stored data.
