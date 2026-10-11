/**
 * Phase 22 — unit tests for the security primitives (no server needed).
 */
import { describe, test, expect } from "bun:test";
import { signWebhookPayload, verifyWebhookSignature } from "../src/lib/webhook-verify";
import {
  encryptCredentials,
  decryptCredentials,
  isEncryptedEnvelope,
  maskCredentials,
} from "../src/lib/crypto";
import { sanitizeCsvCell } from "../src/lib/csv-guard";
import { parseWith, loginSchema, couponCreateSchema } from "../src/lib/validation";
import { hasPermission } from "../src/lib/permissions";
import { assertCsrf, csrfCookieOptions } from "../src/lib/csrf";
import { sessionCookieOptions } from "../src/lib/auth";
import { isSecureRequest } from "../src/lib/proxy";

describe("webhook-verify", () => {
  const secret = "unit-test-secret-that-is-long-enough-1234";

  test("valid signature passes", () => {
    const body = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "x-webhook-signature": signWebhookPayload(secret, ts, body),
      "x-webhook-timestamp": ts,
    });
    expect(verifyWebhookSignature(body, headers, secret).ok).toBe(true);
  });

  test("wrong secret fails", () => {
    const body = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "x-webhook-signature": signWebhookPayload("another-secret-entirely-aaaaaaaa", ts, body),
      "x-webhook-timestamp": ts,
    });
    expect(verifyWebhookSignature(body, headers, secret).ok).toBe(false);
  });

  test("tampered body fails", () => {
    const body = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "x-webhook-signature": signWebhookPayload(secret, ts, body),
      "x-webhook-timestamp": ts,
    });
    expect(verifyWebhookSignature(body + " ", headers, secret).ok).toBe(false);
  });

  test("stale timestamp fails (replay window)", () => {
    const body = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000) - 601);
    const headers = new Headers({
      "x-webhook-signature": signWebhookPayload(secret, ts, body),
      "x-webhook-timestamp": ts,
    });
    const r = verifyWebhookSignature(body, headers, secret);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EXPIRED_TIMESTAMP");
  });

  test("empty secret fails closed", () => {
    const headers = new Headers();
    const r = verifyWebhookSignature("x", headers, "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
});

describe("crypto (integration credentials)", () => {
  const ctx = { hotelId: "hotel-1", integrationType: "SMTP" };

  test("encrypt/decrypt roundtrip", () => {
    const enc = encryptCredentials(ctx, { apiKey: "abc123" });
    expect(isEncryptedEnvelope(enc)).toBe(true);
    const dec = decryptCredentials(ctx, enc);
    expect(dec.apiKey).toBe("abc123");
  });

  test("cross-tenant ciphertext transplant fails (AAD binding)", () => {
    const enc = encryptCredentials(ctx, { apiKey: "abc123" });
    expect(() =>
      decryptCredentials({ hotelId: "hotel-2", integrationType: "SMTP" }, enc),
    ).toThrow();
  });

  test("tampered ciphertext fails auth", () => {
    const enc = encryptCredentials(ctx, { apiKey: "abc123" });
    const parts = enc.split(":");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decryptCredentials(ctx, parts.join(":"))).toThrow();
  });

  test("plaintext is never visible in the envelope", () => {
    const enc = encryptCredentials(ctx, { apiKey: "supersecretvalue" });
    expect(enc).not.toContain("supersecretvalue");
  });

  test("maskCredentials hides values", () => {
    const masked = maskCredentials({ apiKey: "value123" });
    expect(masked.apiKey).not.toContain("value123");
  });
});

describe("csv-guard", () => {
  test("dangerous prefixes are neutralized", () => {
    expect(sanitizeCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(sanitizeCsvCell("+cmd")).toBe("'+cmd");
    expect(sanitizeCsvCell("-1")).toBe("'-1");
    expect(sanitizeCsvCell("@cmd")).toBe("'@cmd");
  });

  test("safe values unchanged", () => {
    expect(sanitizeCsvCell("hello world")).toBe("hello world");
    expect(sanitizeCsvCell(123)).toBe("123");
  });
});

describe("validation", () => {
  test("login schema rejects bad email", () => {
    expect(parseWith(loginSchema, { email: "nope", password: "x" }).ok).toBe(false);
  });

  test("login schema normalizes email case", () => {
    const r = parseWith(loginSchema, { email: "  USER@Example.COM ", password: "secret123" });
    expect(r.ok).toBe(true);
    expect(r.data!.email).toBe("user@example.com");
  });

  test("coupon schema rejects negative discount", () => {
    expect(parseWith(couponCreateSchema, { code: "ABCD", discountValue: -5 }).ok).toBe(false);
  });
});

describe("permissions matrix", () => {
  test("staff cannot write customers", () => {
    expect(hasPermission({ role: "HOTEL_STAFF" }, "CUSTOMER_CREATE")).toBe(false);
  });

  test("owner can manage integrations", () => {
    expect(hasPermission({ role: "HOTEL_OWNER" }, "INTEGRATION_MANAGE")).toBe(true);
  });

  test("super admin does not hold hotel-scoped write permissions", () => {
    expect(hasPermission({ role: "SUPER_ADMIN" }, "CAMPAIGN_SEND")).toBe(false);
    expect(hasPermission({ role: "SUPER_ADMIN" }, "SUPER_ADMIN_ACCESS")).toBe(true);
  });

  test("front desk cannot delete customers", () => {
    expect(hasPermission({ role: "FRONT_DESK" }, "CUSTOMER_DELETE")).toBe(false);
  });

  test("marketing manager can send campaigns but cannot manage staff", () => {
    expect(hasPermission({ role: "MARKETING_MANAGER" }, "CAMPAIGN_SEND")).toBe(true);
    expect(hasPermission({ role: "MARKETING_MANAGER" }, "STAFF_MANAGE")).toBe(false);
  });
});

describe("proxy-aware security (preview gateway fix)", () => {
  /** Build a Request that mimics the preview gateway chain. */
  function gatewayRequest(opts: {
    origin?: string;
    host?: string;
    xfp?: string;
    xfh?: string;
    abc?: string;
    method?: string;
  }) {
    const headers = new Headers();
    if (opts.host) headers.set("host", opts.host);
    if (opts.xfp) headers.set("x-forwarded-proto", opts.xfp);
    if (opts.xfh) headers.set("x-forwarded-host", opts.xfh);
    if (opts.abc) headers.set("abc", opts.abc);
    if (opts.origin) headers.set("origin", opts.origin);
    return new Request("http://internal.app/api/customers", {
      method: opts.method ?? "POST",
      headers,
    });
  }

  const PREVIEW = "https://preview-chat-abc123.space-z.ai";

  test("gateway request (rewritten host + http proto + abc) passes origin check", () => {
    const req = gatewayRequest({
      origin: PREVIEW,
      host: "ws-internal.fcapp.run",
      xfp: "http",
      xfh: "ws-internal.fcapp.run",
      abc: "preview-chat-abc123",
    });
    const result = assertCsrf(req, { hasCookieSession: false });
    expect(result.ok).toBe(true);
  });

  test("scheme-agnostic match: browser http origin on https-claiming proxy passes", () => {
    const req = gatewayRequest({
      origin: "http://localhost:3000",
      host: "localhost:3000",
      xfp: "https",
    });
    expect(assertCsrf(req, { hasCookieSession: false }).ok).toBe(true);
  });

  test("cross-site origin via gateway is still blocked", () => {
    const req = gatewayRequest({
      origin: "https://evil.example.com",
      host: "ws-internal.fcapp.run",
      xfp: "http",
      xfh: "ws-internal.fcapp.run",
      abc: "preview-chat-abc123",
    });
    const result = assertCsrf(req, { hasCookieSession: false });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CSRF_ORIGIN_MISMATCH");
  });

  test("attacker cannot smuggle a trusted host via abc prefix trick (subdomain of evil)", () => {
    const req = gatewayRequest({
      origin: "https://preview-chat-abc123.evil.com",
      host: "ws-internal.fcapp.run",
      xfp: "http",
      abc: "preview-chat-abc123",
    });
    expect(assertCsrf(req, { hasCookieSession: false }).ok).toBe(false);
  });

  test("browser https origin behind proto-lying gateway → Secure cookies", () => {
    const req = gatewayRequest({
      origin: PREVIEW,
      host: "ws-internal.fcapp.run",
      xfp: "http",
      abc: "preview-chat-abc123",
      method: "GET",
    });
    expect(isSecureRequest(req)).toBe(true);
    const cookie = csrfCookieOptions(req);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe("none");
    expect(cookie.partitioned).toBe(true);
    const session = sessionCookieOptions(req);
    expect(session.secure).toBe(true);
    expect(session.sameSite).toBe("none");
  });

  test("plain localhost dev → Lax non-Secure cookies (unchanged)", () => {
    const req = new Request("http://localhost:3000/api/customers", {
      method: "POST",
      headers: new Headers({ host: "localhost:3000" }),
    });
    expect(isSecureRequest(req)).toBe(false);
    expect(sessionCookieOptions(req).sameSite).toBe("lax");
  });

  test("standard https proxy is still detected via X-Forwarded-Proto", () => {
    const req = gatewayRequest({ host: "app.example.com", xfp: "https" });
    expect(isSecureRequest(req)).toBe(true);
  });
});
