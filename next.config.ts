import type { NextConfig } from "next";

/**
 * Security configuration — Phases 17/18, tightened in Phase 7 (spec §32),
 * Phase 8.1 §13: CSP is now ENVIRONMENT-AWARE.
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

const isDev = process.env.NODE_ENV !== "production";

const frameAncestors = process.env.EMBED_FRAME_ANCESTORS?.trim() || (isDev ? "*" : "'self'");

// Dev-only relaxations: eval-based dev tooling (React Refresh / Turbopack).
// NEVER shipped to production — see the note above.
const devScriptSources = isDev ? " 'unsafe-eval'" : "";

// RECHECK FIX (C): Razorpay Checkout JS (loaded by the tenant billing page)
// needs exactly three hosts: the script itself, its iframe (checkout renders
// inside https://api.razorpay.com) and its XHR to the same API host. These
// are HTTPS, host-specific (no wildcards) — narrowly scoped to the payment
// widget, nothing else.
const RAZORPAY_CSP = {
  script: "https://checkout.razorpay.com",
  frame: "https://api.razorpay.com",
  connect: "https://api.razorpay.com",
  img: "https://checkout.razorpay.com https://api.razorpay.com",
} as const;

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${devScriptSources} ${RAZORPAY_CSP.script}`,
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${RAZORPAY_CSP.img}`,
      "font-src 'self' data:",
      `connect-src 'self' ${RAZORPAY_CSP.connect}`,
      `frame-src 'self' ${RAZORPAY_CSP.frame}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
  },
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
  allowedDevOrigins: ["**.space-z.ai"],
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
