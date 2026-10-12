# Initial failures (2026-10-12)

| ID / severity | Reproduction and root cause | Current outcome |
|---|---|---|
| FUNC-001 / High | `src/lib/custom-roles.ts:65` (old resolver) was only called when creating/assigning; `src/lib/permissions.ts:458` (old) used static role map only. A valid custom `INVENTORY_MANAGE` grant for a HOTEL_STAFF was ignored on routes. Reproduce via code trace and `tests/custom-role-api.test.ts` on disposable DB (blocked here). | Fixed in code, mocked resolver test PASS, live proof BLOCKED (Prisma binary). |
| SEC-007 / Low | Public `src/app/api/pay/[token]/{route,checkout/route,verify/route}.ts` had no rate limit; unbounded gateway-order attempts were possible with a known link. | Added distributed/fallback limiter, helper unit PASS. Redis backend NOT TESTED. |
| BUILD-001 / Medium | `bun run build` failed fetching Geist/Geist Mono from Google Fonts. | Self-hosted licensed variable WOFF2; bundle compiles, full build still FAIL due ungenerated Prisma client. |
| DEP-001 / High deployment blocker | `bunx prisma generate --schema prisma/schema.prisma` fails trying to download schema-engine from `binaries.prisma.sh` (restricted egress). | No generated client; `bun run typecheck` 16 errors; integration tests and build blocked. Requires approved binary mirror/network or CI. |
| DEP-002 / High | `bun audit --audit-level=high` reports **26 high** advisories in current installed tree, including lodash via recharts and postcss via Next/Tailwind. | Unresolved; investigate versions and reachable attack surfaces before deployment. |

See `SECURITY_FINDINGS.md`, `DEPENDENCY_AND_DEPLOYMENT.md`, `REMAINING_BLOCKERS.md` for impact and next steps. Nothing in this file asserts a passing deployment.
