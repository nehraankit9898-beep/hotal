import type { NextConfig } from "next";

/**
 * Security configuration — Phases 17/18, tightened in Phase 7 (spec §32).
 * The Content-Security-Policy is built per request (nonce-based) in src/proxy.ts.
 *
 * - `ignoreBuildErrors` has been REMOVED: the production build fails on
 *   TypeScript errors.
 * - CSP (Phase 8.1 §13): Next.js dev tooling (React Refresh / Turbopack HMR)
 *   requires `unsafe-eval` for its runtime — without it the browser console
 *   shows "eval() is not supported in this environment". `unsafe-eval` is
 *   therefore added ONLY when NODE_ENV !== "production". The production CSP
 *   stays strict ('self' + 'unsafe-inline' for the app-router inline bootstrap)
 *   with NO unsafe-eval — there is no documented production requirement for it.
 * - frame-ancestors (Phase 7): defaults to 'self' in production — never a
 *   blind wildcard. Trusted embedding origins must be configured explicitly
 *   via EMBED_FRAME_ANCESTORS (space-separated origins, validated by env.ts).
 *   Development keeps the permissive default so the embedded preview panel
 *   works in sandbox environments.
 */

const securityHeaders = [
  // Content-Security-Policy is NOT set here: it is generated per request with a
  // nonce in src/proxy.ts (SECURITY FIX — the old policy allowed 'unsafe-inline'
  // for every script). See buildPageCsp() there.
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // NOTE: X-Frame-Options is intentionally NOT set (superseded by
  // frame-ancestors; the product supports trusted embedding).
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  // Dev server: allow the embedded preview gateway origins (HMR websockets,
  // fonts, dev overlays) — covers every preview-* session subdomain.
  // Dev-only cross-origin allowlist. Defaults to the platform preview domain;
  // override with DEV_ALLOWED_ORIGINS (comma-separated) for other environments.
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS || "**.space-z.ai")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
