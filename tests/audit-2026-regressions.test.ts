/**
 * Audit regression tests (2026 StayLoop audit). Pure unit tests — no server, no DB.
 *
 *  - SEC-001  staff hierarchy: only the owner may act on an owner account
 *  - SEC-004  isTest() can never be true in production
 *  - SEC-005  readJson enforces the byte cap even without a Content-Length header
 *  - FIN-001  Razorpay webhook releases the dedupe fence when allocation throws
 *             (static source assertion — the behavioural path needs the DB suite)
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { canActOnStaffTarget } from "../src/lib/staff-guards";
import { readJsonCapped, readBodyCapped, MAX_JSON_BODY_BYTES } from "../src/lib/body";

const ROOT = join(import.meta.dir, "..");

describe("SEC-001 staff hierarchy guard", () => {
  test("HOTEL_ADMIN cannot suspend / demote / re-invite the HOTEL_OWNER", () => {
    expect(canActOnStaffTarget("HOTEL_ADMIN", "HOTEL_OWNER")).toBe(false);
  });
  test("HOTEL_OWNER may act on the owner account (no self-lockout rule broken)", () => {
    expect(canActOnStaffTarget("HOTEL_OWNER", "HOTEL_OWNER")).toBe(true);
  });
  test("admins can still manage non-owner staff and peer admins", () => {
    expect(canActOnStaffTarget("HOTEL_ADMIN", "HOTEL_ADMIN")).toBe(true);
    expect(canActOnStaffTarget("HOTEL_ADMIN", "HOTEL_STAFF")).toBe(true);
    expect(canActOnStaffTarget("HOTEL_OWNER", "WAITER")).toBe(true);
  });
  test("route wires the guard before any mutation", () => {
    const src = readFileSync(join(ROOT, "src/app/api/staff/[id]/route.ts"), "utf8");
    const guardAt = src.indexOf("canActOnStaffTarget(auth.user.role, user.role)");
    const firstMutation = src.indexOf("tx.user.update");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(firstMutation);
  });
});

describe("SEC-005 bounded JSON body reads", () => {
  test("accepts a normal small object body", async () => {
    const req = new Request("http://x/api", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(await readJsonCapped(req)).toEqual({ a: 1 });
  });
  test("rejects a body over the cap when Content-Length is absent (chunked stream)", async () => {
    const big = "x".repeat(MAX_JSON_BODY_BYTES + 10);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"v":"'));
        controller.enqueue(new TextEncoder().encode(big));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const req = new Request("http://x/api", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "content-type": "application/json" },
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readJsonCapped(req)).toBeNull();
  });
  test("rejects a declared oversize Content-Length without reading", async () => {
    const req = new Request("http://x/api", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
    });
    expect(await readJsonCapped(req)).toBeNull();
  });
  test("returns null (not throw) for malformed JSON", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "{not json" });
    expect(await readJsonCapped(req)).toBeNull();
  });
  test("readBodyCapped returns text for in-cap bodies", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "hello" });
    expect(await readBodyCapped(req, 100)).toBe("hello");
  });
});

describe("SEC-004 isTest() is never true in production", () => {
  test("NODE_ENV=production + STAYLOOP_TEST=1 → not test", async () => {
    const { isTest } = await import("../src/lib/config");
    const saved = { NODE_ENV: process.env.NODE_ENV, STAYLOOP_TEST: process.env.STAYLOOP_TEST };
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      process.env.STAYLOOP_TEST = "1";
      expect(isTest()).toBe(false);
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      expect(isTest()).toBe(true);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved.NODE_ENV;
      if (saved.STAYLOOP_TEST === undefined) delete process.env.STAYLOOP_TEST;
      else process.env.STAYLOOP_TEST = saved.STAYLOOP_TEST;
    }
  });
});

describe("FIN-001 Razorpay webhook releases dedupe fence on allocation failure", () => {
  test("recordGatewayCapture throw → dedupe row deleted, error re-thrown", () => {
    const src = readFileSync(
      join(ROOT, "src/app/api/webhooks/razorpay-restaurant/route.ts"),
      "utf8",
    );
    const tryAt = src.indexOf("result = await recordGatewayCapture(");
    const catchAt = src.indexOf("} catch (err) {", tryAt);
    const cleanupAt = src.indexOf("restaurantWebhookEvent.deleteMany", catchAt);
    const rethrowAt = src.indexOf("throw err;", catchAt);
    expect(tryAt).toBeGreaterThan(0);
    expect(catchAt).toBeGreaterThan(tryAt);
    expect(cleanupAt).toBeGreaterThan(catchAt);
    expect(rethrowAt).toBeGreaterThan(cleanupAt);
  });
});

describe("SEC-006 logout is CSRF-protected", () => {
  test("cross-site POST with a cookie session is rejected by assertCsrf", async () => {
    const { assertCsrf } = await import("../src/lib/csrf");
    const req = new Request("https://app.example.com/api/auth/logout", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        cookie: "stayloop_session=abc",
        host: "app.example.com",
      },
    });
    const r = assertCsrf(req, { hasCookieSession: true, bearerSession: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CSRF_ORIGIN_MISMATCH");
  });
  test("logout route calls assertCsrf before revoking", () => {
    const src = readFileSync(join(ROOT, "src/app/api/auth/logout/route.ts"), "utf8");
    expect(src.indexOf("assertCsrf(req")).toBeGreaterThan(0);
    expect(src.indexOf("assertCsrf(req")).toBeLessThan(
      src.indexOf("tokenVersion: { increment: 1 }"),
    );
  });
});
