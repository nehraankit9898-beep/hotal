# Authorization matrix — 2026-10-12

Authoritative system map: `src/lib/permissions.ts` (`ROLE_PERMISSIONS`, 11 roles / 88 named permissions), expanded historic table `audit/ROLE_PERMISSION_MATRIX.md`. Tenant context: `requireAuth` in `src/lib/api-helpers.ts` checks DB user status, DB role/hotel/status, tokenVersion and MFA/forced-password gates; it now attaches DB-resolved custom grants on each request. Browser role hiding is not an authority.

| Sensitive action | System-role baseline | Custom grant | Test status |
|---|---|---|---|
| Platform access (`SUPER_ADMIN_ACCESS`) | SUPER_ADMIN only | never | mocked denial PASS; live BLOCKED |
| Staff lifecycle (`STAFF_MANAGE`) | HOTEL_OWNER, HOTEL_ADMIN | never | historical SEC-001 guard unit PASS; live BLOCKED |
| Role management (`CUSTOM_ROLE_MANAGE`) | HOTEL_OWNER, HOTEL_ADMIN | never | mocked owner baseline PASS; live BLOCKED |
| Settings, branch, franchise, integration admin | owner/admin (`ROLE_PERMISSIONS`) | never | static only / NOT TESTED |
| Refund, void, tax | system role according to `ROLE_PERMISSIONS` | never | mocked reserved grants PASS; gateway/DB BLOCKED |
| Attendance manage, inventory manage | mapped system roles | owner/admin may grant by valid active same-hotel role | mocked grant/deny/revoke PASS; live BLOCKED |
| Customer read/export, finance reports, support access | see role table and route guards | non-reserved permission may be grantable where route uses `requirePermission`; route-specific guards still apply | NOT TESTED end-to-end |

Consistency window: next authenticated HTTP request (no process-level permission cache); existing request in flight is not retroactively cancelled. Assignment/update/revoke also bumps target tokenVersion. No cross-tenant privilege from a role belonging to another hotel (`customRole.hotelId = authenticated DB user.hotelId`); missing assignment contributes no grant. Last-owner/admin protection remains in `src/app/api/staff/[id]/route.ts` and `src/lib/staff-guards.ts`; DB race behavior not exercised here. API-key/worker/special authentication paths are not covered by custom-role grants and require separate review.
