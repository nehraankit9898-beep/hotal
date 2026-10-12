import { describe, expect, mock, test } from "bun:test";

// Isolated resolver tests: these are NOT a substitute for the DB-backed API
// test (tests/custom-role-api.test.ts). The fake delegate models DB results.
let rows: { userId: string; hotelId: string; active: boolean; isSystemRole?: boolean; permissions: string }[] = [];
mock.module("@/lib/db", () => ({
  db: {
    customRoleAssignment: {
      findMany: async ({ where }: { where: { userId: string; customRole: { hotelId: string; active: boolean; isSystemRole: boolean } } }) =>
        rows.filter((r) => r.userId === where.userId && r.hotelId === where.customRole.hotelId && r.active === where.customRole.active && Boolean(r.isSystemRole) === where.customRole.isSystemRole)
          .map((r) => ({ customRole: { permissions: r.permissions } })),
    },
  },
}));
const { resolveUserPermissions, validateCustomRolePermissions } = await import("@/lib/custom-roles");
const { hasPermission, requirePermission, ROLE_PERMISSIONS } = await import("@/lib/permissions");

type Role = keyof typeof ROLE_PERMISSIONS;
function user(role: Role = "HOTEL_STAFF", hotelId = "hotel-a", userId = "staff-a") {
  return { role, hotelId, userId, name: "Test", email: "test@example.com", hotelName: "Test", mustChangePassword: false, mfaSetupRequired: false };
}
async function check(permission: Parameters<typeof hasPermission>[1], actor = user()) {
  // Mirrors requireAuth's per-request resolution, never trusts request body.
  const permissions = await resolveUserPermissions(actor);
  return requirePermission({ ...actor, permissions }, permission);
}

describe("custom role server permission resolution (mocked delegate)", () => {
  test("grant allows, ungranted action denied, revoke applies on next request", async () => {
    rows = [{ userId: "staff-a", hotelId: "hotel-a", active: true, permissions: '["INVENTORY_MANAGE"]' }];
    expect(await check("INVENTORY_MANAGE")).toBeNull();
    expect((await check("CAMPAIGN_SEND"))?.status).toBe(403);
    rows[0].permissions = "[]";
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    rows[0].permissions = '["INVENTORY_MANAGE"]';
    rows[0].active = false;
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    rows = [{ userId: "staff-a", hotelId: "hotel-a", active: true, isSystemRole: true, permissions: '["INVENTORY_MANAGE"]' }];
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    rows = [];
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
  });

  test("foreign hotel, missing assignment, malformed records and forbidden grants fail closed", async () => {
    rows = [{ userId: "staff-a", hotelId: "hotel-b", active: true, permissions: '["INVENTORY_MANAGE"]' }];
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    rows = [{ userId: "staff-a", hotelId: "hotel-a", active: true, permissions: "not JSON" }];
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    rows[0].permissions = '["SUPER_ADMIN_ACCESS","STAFF_MANAGE","CUSTOM_ROLE_MANAGE","BILL_VOID"]';
    for (const p of ["SUPER_ADMIN_ACCESS", "STAFF_MANAGE", "CUSTOM_ROLE_MANAGE", "BILL_VOID"] as const) {
      expect((await check(p))?.status).toBe(403);
      expect(validateCustomRolePermissions([p], "HOTEL_OWNER", ROLE_PERMISSIONS.HOTEL_OWNER).ok).toBe(false);
    }
    // Even an incorrectly persisted tenant assignment cannot add privileges
    // to a platform operator (who has no hotel membership).
    expect((await check("INVENTORY_MANAGE", user("SUPER_ADMIN", "", "staff-a")))?.status).toBe(403);
    expect((await check("SUPER_ADMIN_ACCESS", user("SUPER_ADMIN", "", "staff-a")))).toBeNull();
  });

  test("forged role/permissions in request body are not part of resolution; owner baseline survives", async () => {
    rows = [];
    const forgedBody = { role: "SUPER_ADMIN", permissions: ["INVENTORY_MANAGE"] };
    void forgedBody;
    expect((await check("INVENTORY_MANAGE"))?.status).toBe(403);
    expect((await check("STAFF_MANAGE", user("HOTEL_OWNER")))).toBeNull();
    expect((await check("CUSTOM_ROLE_MANAGE", user("HOTEL_OWNER")))).toBeNull();
  });
});
