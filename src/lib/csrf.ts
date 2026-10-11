import { randomBytes, timingSafeEqual } from "crypto";
import { isSecureRequest, allowedRequestHosts } from "./proxy";

/**
 * CSRF protection — Phase 8.
 *
 * Strategy (defense in depth):
 *   1. Same-site Origin/Referer validation on every state-changing request
 *      that presents a session — cross-site callers are rejected outright.
 *      (Scheme-agnostic host matching: see src/lib/proxy.ts for why the
 *      scheme cannot be trusted behind TLS-terminating gateways.)
 *   2. Double-submit cookie: the non-httpOnly `stayloop_csrf` cookie must be
 *      echoed in the `x-csrf-token` header. An attacker on another origin
 *      cannot read the cookie nor set the custom header.
 *   3. Bearer-token sessions (iframe fallback) are inherently CSRF-safe — a
 *      cross-site form cannot attach an Authorization header — so the
 *      double-submit check is skipped for them (Origin check still applies).
 *
 * Exemptions: server-to-server endpoints (webhooks, cron with secret) do NOT
 * use cookie sessions and are validated by their own signature checks.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const CSRF_COOKIE = "stayloop_csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_TOKEN_BYTES = 32;

/** Generate a new CSRF token (random, unguessable, not a secret worth hashing). */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function originOf(headerValue: string | null): URL | null {
  if (!headerValue) return null;
  try {
    return new URL(headerValue);
  } catch {
    return null;
  }
}

/** Debug string for blocked requests (no cookie values — safe to log). */
function originDebug(req: Request): string {
  const hosts = [...allowedRequestHosts(req)].join(" | ") || "(none)";
  return `origin=${req.headers.get("origin") ?? "-"} referer=${req.headers.get("referer") ?? "-"} allowedHosts=[${hosts}]`;
}

export interface CsrfResult {
  ok: boolean;
  status?: number;
  code?: string;
  message?: string;
  /** When true, the caller should issue a fresh CSRF cookie. */
  issueToken?: boolean;
}

/**
 * Validate a state-changing request. Call this BEFORE requireAuth() in every
 * POST/PUT/PATCH/DELETE route handler that authenticates via cookie.
 *
 * `opts.bearerSession` — set true when the request presented a Bearer-token
 * session instead of a cookie (double-submit skipped, Origin still checked).
 */
export function assertCsrf(
  req: Request,
  opts?: { bearerSession?: boolean; hasCookieSession?: boolean },
): CsrfResult {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return { ok: true };

  const origin = originOf(req.headers.get("origin"));
  const referer = originOf(req.headers.get("referer"));

  // 1. Same-site validation — if the browser sent an Origin/Referer, its host
  //    MUST be one of the hostnames this server is actually served under
  //    (see allowedRequestHosts: Host / X-Forwarded-Host / Forwarded /
  //    gateway hints). Browsers always send Origin for cross-site + same-site
  //    POSTs; older clients may omit both, in which case the double-submit
  //    token below still protects cookie sessions.
  if (origin || referer) {
    const source = origin ?? referer!;
    const allowed = allowedRequestHosts(req);
    if (allowed.size === 0 || !allowed.has(source.host.toLowerCase())) {
      console.warn(`[csrf] blocked cross-site request: ${originDebug(req)}`);
      return {
        ok: false,
        status: 403,
        code: "CSRF_ORIGIN_MISMATCH",
        message: "This request came from an unrecognized origin and was blocked.",
      };
    }
  }

  // 2. Double-submit cookie — only for cookie-authenticated sessions.
  const needsDoubleSubmit = opts?.hasCookieSession && !opts?.bearerSession;
  if (needsDoubleSubmit) {
    const cookieHeader = req.headers.get("cookie") ?? "";
    let cookieToken = "";
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === CSRF_COOKIE) {
        // SECURITY/ROBUSTNESS FIX: malformed percent-encoding must not throw (500).
        try {
          cookieToken = decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
          cookieToken = "";
        }
      }
    }
    const headerToken = req.headers.get(CSRF_HEADER) ?? "";
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
      return {
        ok: false,
        status: 403,
        code: "CSRF_TOKEN_INVALID",
        message: "Your session could not be verified. Please refresh the page and try again.",
      };
    }
  }

  return { ok: true };
}

/** Cookie options for the CSRF cookie (JS-readable by design). */
export function csrfCookieOptions(req?: Request) {
  const secure = isSecureRequest(req);
  return {
    httpOnly: false as const,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    partitioned: secure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  };
}

/** Should this request be treated as state-changing (helper for handlers). */
export function isStateChanging(req: Request): boolean {
  return (
    STATE_CHANGING.has(req.method.toUpperCase()) && !SAFE_METHODS.has(req.method.toUpperCase())
  );
}
