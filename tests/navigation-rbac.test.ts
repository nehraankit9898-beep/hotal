/**
 * Phase 8.1 §11 — Role navigation regression tests.
 *
 * The app is a single-page client, so the navigation contract is enforced by
 * two layers, and BOTH are locked in here:
 *
 *  1. SOURCE-level guards — app-shell.tsx must render the platform section
 *     (Super Admin / System Health / Support Sessions) ONLY inside the
 *     SUPER_ADMIN branch, must NEVER render it for hotel roles, and
 *     SUPER_ADMIN must never get the hotel "Settings" nav item.
 *     page.tsx must whitelist SUPER_ADMIN views deterministically.
 *
 *  2. PERMISSION-matrix guards — the server-side RBAC matrix is the source of
 *     truth for what each role can actually do. Platform access is signaled by
 *     SUPER_ADMIN_ACCESS; hotel roles must never hold it, and SUPER_ADMIN must
 *     never hold tenant write powers.
 *
 * (Real enforcement is server-side; tests/super-admin-platform.test.ts proves
 * the 403/401 behavior for every role over HTTP.)
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { ROLE_PERMISSIONS, hasPermission } from "../src/lib/permissions";

const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const HOTEL_ROLES = [
  "HOTEL_ADMIN",
  "HOTEL_OWNER",
  "HOTEL_MANAGER",
  "MARKETING_MANAGER",
  "RESTAURANT_MANAGER",
  "FRONT_DESK",
  "HOTEL_STAFF",
] as const;

describe("Navigation source guard — platform section is SUPER_ADMIN-only", () => {
  const src = read("src/components/app/app-shell.tsx");

  test("NAV_PLATFORM is rendered ONLY in the SUPER_ADMIN branch (exactly once)", () => {
    // count only the platform section render — NAV_PLATFORM_ADMIN must not match
    const occurrences = src.split("renderGroup(NAV_PLATFORM,").length - 1;
    expect(occurrences).toBe(1);
    // and it must sit inside the SUPER_ADMIN ternary arm
    const renderIdx = src.indexOf("renderGroup(NAV_PLATFORM,");
    const branchIdx = src.lastIndexOf('user.role === "SUPER_ADMIN" ?', renderIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    // distance from the branch check to the render must be small (same JSX arm)
    expect(renderIdx - branchIdx).toBeLessThan(200);
  });

  test("the original leak (platform nav for hotel roles) is gone", () => {
    expect(src).not.toContain('renderGroup(NAV_PLATFORM, "Platform (Phase 6)")');
    expect(src).not.toContain('NAV_PLATFORM, "Platform (Phase 6)"');
  });

  test("SUPER_ADMIN branch does NOT render the hotel Administration group", () => {
    // The SUPER_ADMIN arm renders NAV_PLATFORM_ADMIN (platform audit) —
    // never NAV_ADMIN (hotel Audit Logs + Settings).
    const saIdx = src.indexOf('user.role === "SUPER_ADMIN" ?');
    const elseIdx = src.indexOf(": (", saIdx); // start of the non-super-admin arm
    const saArm = src.slice(saIdx, elseIdx);
    expect(saArm).toContain("NAV_PLATFORM_ADMIN");
    expect(saArm).not.toContain("NAV_ADMIN,");
  });

  test("NAV_PLATFORM_ADMIN contains NO hotel Settings item", () => {
    const defStart = src.indexOf("const NAV_PLATFORM_ADMIN");
    const def = src.slice(defStart, src.indexOf("];", defStart));
    expect(def).not.toContain('id: "settings"');
    expect(def).toContain('id: "audit"');
  });

  test("hotel roles keep their own Administration group (audit + settings)", () => {
    const defStart = src.indexOf("const NAV_ADMIN");
    const def = src.slice(defStart, src.indexOf("];", defStart));
    expect(def).toContain('id: "audit"');
    expect(def).toContain('id: "settings"');
  });
});

describe("Routing source guard — SUPER_ADMIN lands on the Control Center", () => {
  const src = read("src/app/page.tsx");

  test("deterministic SUPER_ADMIN view whitelist exists", () => {
    expect(src).toContain("SUPER_ADMIN_ALLOWED");
    const start = src.indexOf("const SUPER_ADMIN_ALLOWED");
    const end = src.indexOf("]);", start);
    const block = src.slice(start, end);
    for (const allowed of [
      "super_admin",
      "system_health",
      "support",
      "notifications",
      "audit",
      "settings",
    ]) {
      expect(block).toContain(`"${allowed}"`);
    }
    // hotel-only views must NOT be whitelisted
    for (const denied of [
      "dashboard",
      "customers",
      "campaigns",
      "restaurant",
      "settings_view_placeholder",
    ]) {
      if (denied === "settings_view_placeholder") continue;
      expect(block).not.toContain(`"${denied}"`);
    }
  });

  test("non-whitelisted views are redirected to the Control Center", () => {
    expect(src).toContain('effectiveView = SUPER_ADMIN_ALLOWED.has(view) ? view : "super_admin"');
  });
});

describe("RBAC permission matrix — platform vs hotel separation", () => {
  test("ONLY SUPER_ADMIN holds SUPER_ADMIN_ACCESS", () => {
    expect(hasPermission({ role: "SUPER_ADMIN" }, "SUPER_ADMIN_ACCESS")).toBe(true);
    for (const role of HOTEL_ROLES) {
      expect(hasPermission({ role }, "SUPER_ADMIN_ACCESS")).toBe(false);
    }
  });

  test("SUPER_ADMIN holds NO hotel-scoped write or read powers", () => {
    for (const perm of [
      "CUSTOMER_READ",
      "CUSTOMER_CREATE",
      "CUSTOMER_UPDATE",
      "CUSTOMER_DELETE",
      "CAMPAIGN_CREATE",
      "CAMPAIGN_SEND",
      "VISIT_CREATE",
      "RESTAURANT_WRITE",
      "SETTINGS_MANAGE",
      "INTEGRATION_MANAGE",
      "STAFF_MANAGE",
      "LOYALTY_MANAGE",
    ] as const) {
      expect(hasPermission({ role: "SUPER_ADMIN" }, perm)).toBe(false);
    }
  });

  test("HOTEL_ADMIN / HOTEL_OWNER have full hotel powers incl. settings + audit", () => {
    for (const role of ["HOTEL_ADMIN", "HOTEL_OWNER"] as const) {
      expect(hasPermission({ role }, "SETTINGS_MANAGE")).toBe(true);
      expect(hasPermission({ role }, "AUDIT_LOG_READ")).toBe(true);
      expect(hasPermission({ role }, "CUSTOMER_DELETE")).toBe(true);
      expect(hasPermission({ role }, "CAMPAIGN_SEND")).toBe(true);
    }
  });

  test("operational/marketing/staff roles stay scoped to their lane", () => {
    expect(hasPermission({ role: "FRONT_DESK" }, "CAMPAIGN_SEND")).toBe(false);
    expect(hasPermission({ role: "FRONT_DESK" }, "AUDIT_LOG_READ")).toBe(false);
    expect(hasPermission({ role: "MARKETING_MANAGER" }, "CUSTOMER_DELETE")).toBe(false);
    expect(hasPermission({ role: "MARKETING_MANAGER" }, "CAMPAIGN_SEND")).toBe(true);
    expect(hasPermission({ role: "RESTAURANT_MANAGER" }, "RESTAURANT_WRITE")).toBe(true);
    expect(hasPermission({ role: "RESTAURANT_MANAGER" }, "CAMPAIGN_SEND")).toBe(false);
    expect(hasPermission({ role: "HOTEL_STAFF" }, "CUSTOMER_CREATE")).toBe(false);
    expect(hasPermission({ role: "HOTEL_STAFF" }, "CUSTOMER_READ")).toBe(true);
  });

  test("matrix has no empty entries for any role", () => {
    for (const role of ["SUPER_ADMIN", ...HOTEL_ROLES] as const) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});
