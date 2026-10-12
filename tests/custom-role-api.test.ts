import { describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { apiCall, login, HOTEL_A_ADMIN, HOTEL_A_STAFF, HOTEL_B_ADMIN, ADMIN_PASSWORD, STAFF_PASSWORD } from "./helpers";

/** Requires scripts/run-tests.ts's disposable SQLite DB and live server.
 * NEVER run against a customer or production database. */
describe("custom role API — authoritative server permissions and revocation", () => {
  test("grant, cross-tenant denial, revoke, disabled account, forged claims", async () => {
    const admin = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    const foreignAdmin = await login(HOTEL_B_ADMIN, ADMIN_PASSWORD);
    let staff = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(admin.res.status).toBe(200);
    expect(foreignAdmin.res.status).toBe(200);
    expect(staff.res.status).toBe(200);
    const target = await db.user.findUnique({ where: { email: HOTEL_A_STAFF } });
    const foreign = await db.user.findUnique({ where: { email: HOTEL_B_ADMIN } });
    expect(target?.id).toBeTruthy();
    expect(foreign?.id).toBeTruthy();
    const inventory = "/api/inventory/ingredients";
    expect((await apiCall("GET", inventory, { jar: staff.jar })).status).toBe(200); // HOTEL_STAFF baseline has INVENTORY_READ
    const protectedAction = "/api/attendance"; // HOTEL_STAFF lacks ATTENDANCE_MANAGE
    expect((await apiCall("POST", protectedAction, { jar: staff.jar, body: { role: "HOTEL_OWNER", permissions: ["ATTENDANCE_MANAGE"] } })).status).toBe(403);

    const name = `Test role ${Date.now()}`;
    const create = await apiCall("POST", "/api/custom-roles", { jar: admin.jar,
      body: { name, permissions: ["ATTENDANCE_MANAGE"] } });
    expect(create.status).toBe(201);
    const id = create.body.id as string;
    expect((await apiCall("POST", `/api/custom-roles/${id}/assign`, { jar: foreignAdmin.jar,
      body: { userId: foreign?.id } })).status).toBe(404);
    expect((await apiCall("POST", `/api/custom-roles/${id}/assign`, { jar: admin.jar,
      body: { userId: foreign?.id } })).status).toBe(404);
    expect((await apiCall("POST", `/api/custom-roles/${id}/assign`, { jar: admin.jar,
      body: { userId: target?.id } })).status).toBe(200);
    // Assignment revokes existing sessions. A fresh session observes the grant.
    expect((await apiCall("GET", inventory, { jar: staff.jar })).status).toBe(401);
    staff = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(staff.res.status).toBe(200);
    // Use the permission on a read route instead of mutating attendance.
    const role = await db.customRole.findUnique({ where: { id } });
    expect(role?.permissions).toContain("ATTENDANCE_MANAGE");
    // No client role field is consulted by the server.
    expect((await apiCall("POST", protectedAction, { jar: staff.jar,
      body: { role: "HOTEL_OWNER", permissions: ["ATTENDANCE_MANAGE"] } })).status).not.toBe(403);
    const patch = await apiCall("PATCH", `/api/custom-roles/${id}`, { jar: admin.jar, body: { permissions: [] } });
    expect(patch.status).toBe(200);
    expect((await apiCall("GET", inventory, { jar: staff.jar })).status).toBe(401);
    staff = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(staff.res.status).toBe(200);
    expect((await apiCall("POST", protectedAction, { jar: staff.jar, body: {} })).status).toBe(403);
    expect((await apiCall("DELETE", `/api/custom-roles/${id}/assign`, { jar: admin.jar,
      body: { userId: target?.id } })).status).toBe(200);
    expect((await apiCall("GET", inventory, { jar: staff.jar })).status).toBe(401);

    // A suspended account cannot retain access even with an active grant.
    const regrant = await apiCall("PATCH", `/api/custom-roles/${id}`, { jar: admin.jar,
      body: { permissions: ["ATTENDANCE_MANAGE"] } });
    expect(regrant.status).toBe(200);
    expect((await apiCall("POST", `/api/custom-roles/${id}/assign`, { jar: admin.jar,
      body: { userId: target?.id } })).status).toBe(200);
    staff = await login(HOTEL_A_STAFF, STAFF_PASSWORD);
    expect(staff.res.status).toBe(200);
    const suspend = await apiCall("PATCH", `/api/staff/${target?.id}`, { jar: admin.jar, body: { deactivate: true } });
    expect(suspend.status).toBe(200);
    expect((await apiCall("GET", inventory, { jar: staff.jar })).status).toBe(401);
    expect((await login(HOTEL_A_STAFF, STAFF_PASSWORD)).res.status).not.toBe(200);
    const restore = await apiCall("PATCH", `/api/staff/${target?.id}`, { jar: admin.jar, body: { reactivate: true } });
    expect(restore.status).toBe(200);
    // A reserved/ungrantable permission is a VALIDATION failure: 422, the same
    // code the sibling PATCH handler and the rest of this POST route use for
    // invalid payloads (this assertion used to pin the old 400 fallback).
    expect((await apiCall("POST", "/api/custom-roles", { jar: admin.jar,
      body: { name: `${name} forbidden`, permissions: ["SUPER_ADMIN_ACCESS"] } })).status).toBe(422);
  }, 120_000);
});
