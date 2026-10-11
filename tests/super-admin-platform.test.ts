/**
 * Phase 8.1 §6/§12 — Super Admin platform power + API RBAC regression tests.
 *
 * Proves for EVERY /api/super-admin/* route:
 *   SUPER_ADMIN  → allowed (200/201)
 *   hotel roles  → 403 (all eight hotel roles, incl. HOTEL_ADMIN)
 *   unauthed     → 401
 * Plus:
 *   - super admin CAN create / suspend / activate hotels, toggle tenant
 *     feature flags, create support sessions, inspect usage + health,
 *     and read the cross-tenant platform audit trail,
 *   - super admin CANNOT touch hotel-scoped /api/settings or /api/audit-logs,
 *   - super admin gets NO tenant write powers (customers/campaigns),
 *   - tenant isolation: super admin is never silently converted into a tenant.
 */
import { describe, test, expect } from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  apiCall,
  jarFromResponse,
  login,
  ADMIN_PASSWORD,
  HOTEL_A_ADMIN,
  HOTEL_A_STAFF,
} from "./helpers";
import { hashPassword } from "../src/lib/auth";
import { generateTotp } from "../src/lib/mfa";

const BOOTSTRAP_SECRET =
  process.env.ADMIN_BOOTSTRAP_SECRET ?? "test-bootstrap-secret-0123456789abcdef0123456789abcdef";
const SA_EMAIL = "platform-admin@stayloop.test";
const SA_PASSWORD = "PlatformAdmin123";
const ROLE_USER_PASSWORD = "RoleProbe123";

const db = new PrismaClient();

/** All platform endpoints (with probe ids) — used for deny-matrix checks. */
const PLATFORM_GETS = [
  "/api/super-admin/stats",
  "/api/super-admin/hotels",
  "/api/super-admin/health",
  "/api/super-admin/support",
  "/api/super-admin/audit",
  "/api/super-admin/usage?id=probe", // guard check happens before hotel lookup
  "/api/super-admin/features?id=probe",
];

/** Endpoints that must return 200 for a legitimate super admin. */
const PLATFORM_GETS_OK = [
  "/api/super-admin/stats",
  "/api/super-admin/hotels",
  "/api/super-admin/health",
  "/api/super-admin/support",
  "/api/super-admin/audit",
];

/** Create (or reuse) one user per hotel role so every role is really tested. */
async function ensureRoleUser(role: string, email: string, hotelId: string) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({
    data: {
      email,
      name: `${role} Probe`,
      passwordHash: hashPassword(ROLE_USER_PASSWORD),
      role: role as never,
      hotelId,
      status: "ACTIVE",
      mustChangePassword: false,
    },
  });
}

let saJar: { cookie: string; csrf: string };

describe("Super Admin — bootstrap and platform power", () => {
  test("bootstrap → forced password change → full platform session", async () => {
    const boot = await apiCall("POST", "/api/super-admin/bootstrap", {
      headers: { "x-bootstrap-secret": BOOTSTRAP_SECRET },
      body: { name: "Platform Super Admin", email: SA_EMAIL },
    });
    // 201 on first run; 409 ALREADY_BOOTSTRAPPED when re-run against a seeded DB
    expect([201, 409]).toContain(boot.status);

    let tempPassword = boot.body?.temporaryPassword ?? "";
    if (boot.status === 409) {
      // Already bootstrapped in a previous run of this suite: the password was
      // changed to SA_PASSWORD then. Verify it still works below.
    } else {
      expect(tempPassword).toBeTruthy();
      // mustChangePassword session may ONLY change its password via /api/profile
      const forced = await fetch("http://localhost:3100/api/super-admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: SA_EMAIL, password: tempPassword }),
      });
      expect(forced.status).toBe(200);
      const forcedJar = jarFromResponse(forced);
      const statsWhileForced = await apiCall("GET", "/api/super-admin/stats", { jar: forcedJar });
      expect(statsWhileForced.status).toBe(403); // PASSWORD_CHANGE_REQUIRED
      const change = await apiCall("PATCH", "/api/profile", {
        jar: forcedJar,
        body: { currentPassword: tempPassword, newPassword: SA_PASSWORD },
      });
      expect(change.status).toBe(200);
    }

    // Idempotent re-runs: if a previous run enrolled MFA on this DB, clear it
    // so the fresh-login path (password → restricted session → enrolment) is
    // exercised exactly like a brand-new operator.
    await db.user.updateMany({
      where: { email: SA_EMAIL },
      data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null },
    });

    // Real login with the permanent password
    const loginRes = await fetch("http://localhost:3100/api/super-admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: SA_EMAIL, password: SA_PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    saJar = jarFromResponse(loginRes);
    expect(saJar.cookie).toContain("stayloop_session=");

    // Phase 10 §14 — MFA is MANDATORY for SUPER_ADMIN: until enrolment the
    // session is restricted (MFA_SETUP_REQUIRED). Enrol TOTP to unlock the
    // full platform session, exactly like a real operator would.
    const restricted = await apiCall("GET", "/api/super-admin/stats", { jar: saJar });
    expect(restricted.status).toBe(403);
    expect(restricted.body?.error?.code).toBe("MFA_SETUP_REQUIRED");
    const mfaSetup = await apiCall("POST", "/api/mfa/setup", { jar: saJar, body: {} });
    expect(mfaSetup.status).toBe(200);
    expect(mfaSetup.body?.secret).toBeTruthy();
    const mfaEnable = await apiCall("POST", "/api/mfa/enable", {
      jar: saJar,
      body: { code: generateTotp(mfaSetup.body.secret) },
    });
    expect(mfaEnable.status).toBe(200);
    expect(mfaEnable.body?.backupCodes?.length).toBe(10);
    // Same session is now fully unlocked (server checks live mfaEnabled).
    const unlocked = await apiCall("GET", "/api/super-admin/stats", { jar: saJar });
    expect(unlocked.status).toBe(200);
  });

  test("super admin session has empty hotelId — never a tenant actor", async () => {
    const me = await apiCall("GET", "/api/auth/me", { jar: saJar });
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("SUPER_ADMIN");
    expect(me.body.user.hotelId).toBe("");
  });

  test("super admin can view platform stats, hotels, health, support, audit", async () => {
    for (const path of PLATFORM_GETS_OK) {
      const res = await apiCall("GET", path, { jar: saJar });
      expect(res.status).toBe(200);
    }
    // unknown hotel → guard passes (not 401/403), then 404 from the lookup
    expect((await apiCall("GET", "/api/super-admin/usage?id=probe", { jar: saJar })).status).toBe(
      404,
    );
    const audit = await apiCall("GET", "/api/super-admin/audit", { jar: saJar });
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.logs)).toBe(true);
    expect(Array.isArray(audit.body.actions)).toBe(true);
  });

  test("super admin can view a hotel's owner info + usage", async () => {
    const hotels = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    expect(hotels.status).toBe(200);
    const grand = (hotels.body.hotels ?? []).find(
      (h: { name: string }) => h.name === "Grand Palace Hotel",
    );
    expect(grand).toBeTruthy();
    expect(grand.owner === null || typeof grand.owner === "object").toBe(true);
    const usage = await apiCall("GET", `/api/super-admin/usage?id=${grand.id}`, { jar: saJar });
    expect(usage.status).toBe(200);
    expect(usage.body.usage).toBeTruthy();
  });

  test("super admin can CREATE a hotel tenant (owner gets a one-time invitation)", async () => {
    const created = await apiCall("POST", "/api/super-admin/hotels", {
      jar: saJar,
      body: {
        name: "RBAC Probe Palace",
        city: "Mumbai",
        country: "India",
        planName: "STARTER",
        ownerName: "Probe Owner",
        ownerEmail: "rbac-probe-owner@stayloop.test",
      },
    });
    // 201 on first run; 400 when the owner email already exists (re-run)
    expect([201, 400]).toContain(created.status);
    if (created.status === 201) {
      expect(created.body.hotel.name).toBe("RBAC Probe Palace");
    }
  });

  test("super admin can SUSPEND and ACTIVATE a hotel", async () => {
    const hotels = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    const probe =
      (hotels.body.hotels ?? []).find((h: { name: string }) => h.name === "RBAC Probe Palace") ??
      (hotels.body.hotels ?? []).find((h: { name: string }) => h.name === "Sea View Resort");
    expect(probe).toBeTruthy();

    const suspended = await apiCall("POST", `/api/super-admin/hotels/suspend?id=${probe.id}`, {
      jar: saJar,
      body: { reason: "Phase 8.1 RBAC test suspension" },
    });
    expect(suspended.status).toBe(200);

    const afterSuspend = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    const nowSuspended = (afterSuspend.body.hotels ?? []).find(
      (h: { id: string }) => h.id === probe.id,
    );
    expect(nowSuspended.status).toBe("SUSPENDED");

    const activated = await apiCall("POST", `/api/super-admin/hotels/activate?id=${probe.id}`, {
      jar: saJar,
    });
    expect(activated.status).toBe(200);

    const afterActivate = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    const nowActive = (afterActivate.body.hotels ?? []).find(
      (h: { id: string }) => h.id === probe.id,
    );
    expect(nowActive.status).toBe("ACTIVE");
  });

  test("super admin can TOGGLE tenant feature flags (and restore them)", async () => {
    const hotels = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    const grand = (hotels.body.hotels ?? []).find(
      (h: { name: string }) => h.name === "Grand Palace Hotel",
    );
    const flags = await apiCall("GET", `/api/super-admin/features?id=${grand.id}`, { jar: saJar });
    expect(flags.status).toBe(200);
    const key = flags.body.availableKeys[0];
    const current = (flags.body.features ?? []).find(
      (f: { featureKey: string }) => f.featureKey === key,
    );

    const toggled = await apiCall("PUT", `/api/super-admin/features?id=${grand.id}`, {
      jar: saJar,
      body: { featureKey: key, enabled: !(current?.enabled ?? false) },
    });
    expect(toggled.status).toBe(200);
    // restore
    const restored = await apiCall("PUT", `/api/super-admin/features?id=${grand.id}`, {
      jar: saJar,
      body: { featureKey: key, enabled: current?.enabled ?? false },
    });
    expect(restored.status).toBe(200);
  });

  test("super admin can CREATE a support session for a hotel", async () => {
    const hotels = await apiCall("GET", "/api/super-admin/hotels", { jar: saJar });
    const grand = (hotels.body.hotels ?? []).find(
      (h: { name: string }) => h.name === "Grand Palace Hotel",
    );
    const res = await apiCall("POST", `/api/super-admin/support?id=${grand.id}`, {
      jar: saJar,
      body: { reason: "Phase 8.1 support RBAC verification", durationMinutes: 30 },
    });
    expect([200, 201]).toContain(res.status);
  });

  test("super admin CANNOT access hotel-scoped settings or hotel audit logs", async () => {
    expect((await apiCall("GET", "/api/settings", { jar: saJar })).status).toBe(403);
    expect(
      (await apiCall("PUT", "/api/settings", { jar: saJar, body: { marketingFrequencyLimit: 3 } }))
        .status,
    ).toBe(403);
    expect((await apiCall("GET", "/api/audit-logs", { jar: saJar })).status).toBe(403);
  });

  test("super admin gets NO hotel-scoped campaign/customer write powers", async () => {
    expect((await apiCall("GET", "/api/customers", { jar: saJar })).status).toBe(403);
    expect(
      (
        await apiCall("POST", "/api/customers", {
          jar: saJar,
          body: { name: "Nope", phone: "+919000000009" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await apiCall("POST", "/api/campaigns", { jar: saJar, body: { name: "Nope" } })).status,
    ).toBe(403);
    expect((await apiCall("GET", "/api/restaurant/leaderboard", { jar: saJar })).status).toBe(403);
  });
});

describe("Platform APIs deny EVERY hotel role (incl. HOTEL_ADMIN)", () => {
  const ROLE_EMAILS: [string, string][] = [
    ["HOTEL_OWNER", "owner-probe@grandpalace.test"],
    ["HOTEL_MANAGER", "manager-probe@grandpalace.test"],
    ["MARKETING_MANAGER", "marketing-probe@grandpalace.test"],
    ["RESTAURANT_MANAGER", "restaurant-probe@grandpalace.test"],
    ["FRONT_DESK", "frontdesk-probe@grandpalace.test"],
  ];

  test("setup: per-role probe users exist in hotel A", async () => {
    const hotelA = await db.hotel.findFirst({ where: { name: "Grand Palace Hotel" } });
    expect(hotelA).toBeTruthy();
    for (const [role, email] of ROLE_EMAILS) {
      await ensureRoleUser(role, email, hotelA!.id);
    }
  });

  test("each hotel role gets 403 on every platform endpoint (GET + state-changing)", async () => {
    const sessions: { email: string; jar: { cookie: string; csrf: string } }[] = [];
    for (const [role, email] of ROLE_EMAILS) {
      const res = await fetch("http://localhost:3100/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: ROLE_USER_PASSWORD }),
      });
      expect(res.status).toBe(200);
      sessions.push({ email, jar: jarFromResponse(res) });
    }

    // Seeded roles too
    const admin = await login(HOTEL_A_ADMIN, ADMIN_PASSWORD);
    const staff = await login(HOTEL_A_STAFF, process.env.TEST_STAFF_PASSWORD ?? "TestStaff123");
    sessions.push(
      { email: HOTEL_A_ADMIN, jar: admin.jar },
      { email: HOTEL_A_STAFF, jar: staff.jar },
    );

    for (const { email, jar } of sessions) {
      for (const path of PLATFORM_GETS) {
        const res = await apiCall("GET", path, { jar });
        expect(res.status).toBe(403);
      }
      // state-changing platform actions
      expect(
        (
          await apiCall("POST", "/api/super-admin/hotels", {
            jar,
            body: { name: "Hijack", ownerEmail: "x@y.z" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiCall("POST", "/api/super-admin/hotels/suspend?id=whatever", {
            jar,
            body: { reason: "nope" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await apiCall("POST", "/api/super-admin/hotels/activate?id=whatever", { jar })).status,
      ).toBe(403);
      expect(
        (
          await apiCall("PUT", "/api/super-admin/features?id=whatever", {
            jar,
            body: { featureKey: "x", enabled: true },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiCall("POST", "/api/super-admin/support?id=whatever", {
            jar,
            body: { reason: "nope", durationMinutes: 10 },
          })
        ).status,
      ).toBe(403);
    }
  });

  test("unauthenticated callers get 401 (not 403) from platform endpoints", async () => {
    for (const path of PLATFORM_GETS) {
      const res = await apiCall("GET", path);
      expect(res.status).toBe(401);
    }
    expect(
      (await apiCall("POST", "/api/super-admin/hotels/suspend?id=x", { body: { reason: "anon" } }))
        .status,
    ).toBe(401);
    expect((await apiCall("GET", "/api/super-admin/audit")).status).toBe(401);
  });
});
