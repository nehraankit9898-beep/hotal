# Functional Bugs — StayLoop audit (2026-10-11)

Only defects that were confirmed by reading the source are listed. Where a feature could not be exercised
end to end, that is stated in `TEST_RESULTS.md`, not counted as a pass.

## FUNC-001 — Custom-role permission grants are never enforced (High, functional)
- **Feature:** Custom roles (`/api/custom-roles`, `/api/custom-roles/[id]/assign`)
- **Files:** `src/lib/custom-roles.ts` (`resolveUserPermissions`, lines ~60–100, and the comment on line 60 that says it is "called by hasPermission"); `src/lib/permissions.ts` (`hasPermission`, `requirePermission`)
- **Observed:** `resolveUserPermissions()` merges a user's custom-role grants with the legacy role list. Its
  only call sites are inside `custom-roles.ts` (lines 116 and 160), and both use it to check what a *caller* may
  grant when creating or assigning a role. `hasPermission()` and `requirePermission()` are synchronous and read
  only the static `ROLE_PERMISSIONS` table. **A permission granted through a custom role therefore never unlocks
  a route.** The doc comment that says the function is "called by hasPermission" is wrong.
- **Expected:** A HOTEL_STAFF assigned a custom role that includes `INVENTORY_READ` can read inventory.
  **Actual:** That request still returns 403.
- **Security impact:** None (fails closed). No escalation path was found. Custom roles cannot grant
  `SUPER_ADMIN_ACCESS` (`PERMISSIONS` allowlist and `ALLOWED_CUSTOM_PERMISSIONS` both exclude it, per the
  comments; the exclusion itself was not dynamically tested).
- **Business impact:** A documented feature silently does nothing. Owners who configure custom roles get no error.
- **Root cause:** Permission checks are synchronous and DB-free; custom roles were added later and not wired in.
- **Fix status: NOT FIXED in this pass.** Correct fix: make `requirePermission` async and have it call
  `resolveUserPermissions` (the DB lookup is already written). That touches roughly 200 call sites, so it needs its
  own change with a per-request cache and a DB-backed test. Until then, custom roles should be hidden in the UI or
  labelled as not yet enforced.
- **Regression test:** None yet. Required: a DB-backed test that assigns a custom role with an extra permission
  and asserts the route is allowed (currently it would be denied).

## Notes on other functional areas
- No other functional defect was confirmed by source review. This is **not** evidence that the other features work:
  end-to-end checks of CRM, campaigns, POS, billing, and inventory were NOT run (see `TEST_RESULTS.md`).
- The existing suites (`tests/*.test.ts`, `scripts/test-phase*.ts`) assume a running server backed by a working
  database. In this sandbox they fail before any assertion, so they give no evidence either way.

## DOC-001 — Security documentation says MFA is missing (Low, documentation)
- **File:** `docs/SECURITY.md`, risk R-5 ("No MFA despite schema fields — documented gap").
- **Observed:** MFA is implemented: `src/app/api/mfa/{setup,enable,disable,backup-codes}`, `src/app/api/auth/mfa/verify`,
  and `src/lib/mfa.ts`. `POST /api/mfa/disable` requires a current TOTP or backup code (verified by reading the route).
- **Impact:** Operators and auditors may conclude MFA is absent and miss the real controls, or the reverse.
- **Status:** Not edited in this pass (documentation owner decides the wording). MFA enforcement, recovery, and
  lockout behavior were NOT exercised dynamically.
- **Other doc claims checked and matching the code:** lockout 5 failures with 15m/30m/60m/24h steps
  (`src/lib/login-security.ts`); reset tokens are 32 random bytes stored as SHA-256 (`src/lib/security-tokens.ts`).
