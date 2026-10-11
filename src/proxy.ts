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

  const res = NextResponse.next();
  res.headers.set("x-request-id", requestId);
  if (isApi) return applyCorsHeaders(req, res);
  return res;
}

export const config = {
  // API routes only — pages set their own security headers in next.config.ts.
  matcher: ["/api/:path*"],
};
