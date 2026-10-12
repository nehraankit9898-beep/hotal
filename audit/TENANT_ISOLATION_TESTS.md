# Tenant isolation coverage — 2026-10-12

Scope covered by code change: `CustomRole.hotelId` and `CustomRoleAssignment.customRole` (`src/lib/custom-roles.ts:75-78`, `src/app/api/custom-roles/[id]/route.ts`, `[id]/assign/route.ts`). `requireAuth` derives user.hotelId from DB, never a client tenant field. The resolver selects active roles with that hotelId and userId; assignment/revocation route scopes role AND target to caller hotel. Legacy baseline is DB role, not client body.

| Scenario | Evidence / result |
|---|---|
| Hotel B assignment offered to Hotel A user | resolver mocked delegate: foreign record denied, PASS (`tests/custom-role-resolution.test.ts`). |
| Revocation, missing record, corrupt JSON, inactive role | mocked delegate: denied on next resolution, PASS. |
| Forged role/permission in request body | no input to resolver; mocked unit PASS; live API in `tests/custom-role-api.test.ts` BLOCKED. |
| Two real tenant users, staff suspension, role update, token revocation | integration test authored, **BLOCKED** by Prisma engine. |
| Customers/orders/branches/financial exports, bulk, nested IDs, jobs, pagination, concurrent revocation | **NOT TESTED**; older `tests/rbac-tenant.test.ts` is source-only evidence until DB/server test runner runs. |

No claim of route-complete coverage: 204 route files and 110 models require further per-handler isolation review, including join rows with no direct hotelId. See `audit/ROUTE_INVENTORY.md` and `audit/DATABASE_AND_MIGRATION_AUDIT.md` (historical static inventory).
