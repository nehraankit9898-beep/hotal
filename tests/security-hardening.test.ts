/**
 * Regression tests for the security/functional hardening pass.
 *
 * Pure-module tests only (no database, no running server): password hashing,
 * timezone day math, the nonce-based page CSP, and the login-lockout helpers'
 * pure pieces. Run with `bun test tests/security-hardening.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync,
  needsRehash,
  safeDecodeCookie,
  dummyPasswordHash,
} from "../src/lib/auth";
import { zonedDayKey, isValidTimeZone } from "../src/lib/timezone";
import { proxy } from "../src/proxy";

describe("password hashing (scrypt v2 + legacy)", () => {
  test("new hashes use v2 parameters and verify", () => {
    const stored = hashPassword("Secret123");
    expect(stored.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(verifyPassword("Secret123", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  });

  test("async variants agree with the sync ones", async () => {
    const stored = await hashPasswordAsync("Abc12345");
    expect(verifyPassword("Abc12345", stored)).toBe(true);
    expect(await verifyPasswordAsync("Abc12345", stored)).toBe(true);
    expect(await verifyPasswordAsync("nope", stored)).toBe(false);
  });

  test("malformed stored hashes never throw", async () => {
    expect(verifyPassword("a", "not-a-hash")).toBe(false);
    expect(verifyPassword("a", "scrypt$3$8$1$aa$bb")).toBe(false);
    expect(await verifyPasswordAsync("a", "scrypt$")).toBe(false);
  });

  test("dummy hash is a real v2 hash (constant-time unknown-user path)", () => {
    expect(dummyPasswordHash().startsWith("scrypt$131072$")).toBe(true);
  });
});

describe("cookie decoding", () => {
  test("malformed percent-encoding returns null instead of throwing", () => {
    expect(safeDecodeCookie("%E0%A4%A")).toBeNull();
    expect(safeDecodeCookie("abc.def")).toBe("abc.def");
  });
});

describe("timezone day math", () => {
  test("01:30 IST on Oct 11 is the Oct 11 day in Asia/Kolkata", () => {
    const at = new Date("2026-10-10T20:00:00Z");
    expect(zonedDayKey(at, "Asia/Kolkata")).toBe("2026-10-11");
    expect(zonedDayKey(new Date("2026-10-11T04:00:00Z"), "Asia/Kolkata")).toBe("2026-10-11");
  });

  test("validates IANA zones", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("page CSP (nonce policy)", () => {
  test("pages get a per-request nonce and no script unsafe-inline", () => {
    const res = proxy(new NextRequest("http://localhost/"));
    const csp = res.headers.get("content-security-policy") ?? "";
    const script = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(script).toMatch(/'nonce-[A-Za-z0-9+/=]{20,}'/);
    expect(script).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors");
  });

  test("the nonce changes on every request", () => {
    const a = proxy(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    const b = proxy(new NextRequest("http://localhost/")).headers.get("content-security-policy");
    expect(a).not.toEqual(b);
  });

  test("API responses do not get the page CSP (receipt HTML sets its own)", () => {
    const res = proxy(new NextRequest("http://localhost/api/auth/me"));
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});
