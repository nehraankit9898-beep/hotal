import { NextResponse, type NextRequest } from "next/server";

/**
 * Phase 7 — edge middleware: request correlation + strict CORS (spec §30, §33).
 *
 * 1. **Request IDs** — every API response carries `x-request-id` (generated
 *    per request or forwarded from a trusted upstream) so logs and client
 *    bug reports can be correlated. The id is echoed in error responses by
 *    the central error handler.
 *
 * 2. **CORS** — the API is same-origin by default (cookies + CSRF). Cross-
 *    origin browser access is granted ONLY to exact origins listed in
 *    TRUSTED_ORIGINS (comma/space separated, validated by env.ts). Never a
 *    wildcard for credentialed APIs. Non-matching origins get no CORS headers
 *    and preflights are rejected — browsers block the response.
 */

function parseTrustedOrigins(): string[] {
  return (process.env.TRUSTED_ORIGINS || "")
    .split(/[\s,]+/)
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o && o.startsWith("http"));
}

function isAllowedOrigin(origin: string): boolean {
  return parseTrustedOrigins().includes(origin);
}

function applyCorsHeaders(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get("origin");
  if (!origin) return res; // same-origin / non-browser — no CORS headers
  if (!isAllowedOrigin(origin)) return res; // unknown origin — no grant

  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, x-csrf-token, x-request-id, Authorization",
  );
  res.headers.set("Access-Control-Max-Age", "600");
  return res;
}

const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * Razorpay Checkout JS (loaded by the tenant billing page) needs exactly these
 * HTTPS hosts: the script, its iframe, and its XHR. Narrowly scoped.
 */
const RAZORPAY_CSP = {
  script: "https://checkout.razorpay.com",
  frame: "https://api.razorpay.com",
  connect: "https://api.razorpay.com",
  img: "https://checkout.razorpay.com https://api.razorpay.com",
} as const;

/** 128-bit base64 nonce, unique per request. */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * SECURITY FIX (CSP): the page policy used to contain 'unsafe-inline' for scripts,
 * which lets any injected inline script run. Scripts now need the per-request
 * nonce (Next.js applies it to its own bootstrap scripts automatically).
 * 'unsafe-inline' remains for STYLES only (component libraries use style attributes).
 * Dev keeps 'unsafe-eval' because React Refresh / Turbopack require it.
 */
function buildPageCsp(nonce: string): string {
  // Embedding policy: explicit origins only in production (never a blind wildcard).
  const frameAncestors = process.env.EMBED_FRAME_ANCESTORS?.trim() || (IS_DEV ? "*" : "'self'");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${IS_DEV ? " 'unsafe-eval'" : ""} ${RAZORPAY_CSP.script}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${RAZORPAY_CSP.img}`,
    "font-src 'self' data:",
    `connect-src 'self' ${RAZORPAY_CSP.connect}`,
    `frame-src 'self' ${RAZORPAY_CSP.frame}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

export function proxy(req: NextRequest) {
  // Correlation id: forward an upstream id when present, else generate one.
  const incoming = req.headers.get("x-request-id");
  const requestId =
    incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();

  const isApi = req.nextUrl.pathname.startsWith("/api");

  // CORS preflight for the API.
  if (isApi && req.method === "OPTIONS") {
    const preflight = new NextResponse(null, {
      status: isAllowedOrigin(req.headers.get("origin") ?? "") ? 204 : 403,
    });
    if (isAllowedOrigin(req.headers.get("origin") ?? "")) {
      return applyCorsHeaders(req, preflight);
    }
    return preflight;
  }

  if (isApi) {
    const res = NextResponse.next();
    res.headers.set("x-request-id", requestId);
    return applyCorsHeaders(req, res);
  }

  // Pages: nonce-based CSP. The nonce goes on the REQUEST so Next.js can apply it
  // to its inline bootstrap scripts, and the policy goes on the RESPONSE.
  const nonce = generateNonce();
  const csp = buildPageCsp(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = {
  // Everything except static build assets (they carry no HTML and no nonce).
  // API routes keep CORS handling; pages get the nonce CSP.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
