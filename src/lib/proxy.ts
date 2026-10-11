/**
 * Reverse-proxy awareness — shared helpers for detecting (a) whether the
 * ORIGINAL client connection used HTTPS, and (b) which public hostnames this
 * server is legitimately served under (for the CSRF same-site check).
 *
 * WHY THIS EXISTS: TLS-terminating gateways and CDNs talk plain HTTP to the
 * app and frequently rewrite Host / X-Forwarded-* along the way. The embedded
 * preview gateway used by this product, for example:
 *   - rewrites Host and X-Forwarded-Host to an internal function host,
 *   - sets X-Forwarded-Proto to "http",
 *   - preserves the ORIGINAL public hostname only in the custom `abc` header.
 *
 * Without these helpers:
 *   - session/CSRF cookies were marked SameSite=Lax + non-Secure → browsers
 *     refused to store them in the cross-site preview iframe → "login
 *     succeeds but session is lost" (user stays on the login screen);
 *   - the CSRF origin check compared the browser's real origin
 *     (https://preview-….space-z.ai) against the rewritten internal host
 *     (http://ws-….fcapp.run) → every browser POST was rejected with
 *     "This request came from an unrecognized origin and was blocked."
 */

/** Public suffix of preview hostnames delivered via the gateway `abc` header. */
const GATEWAY_PUBLIC_SUFFIX = (process.env.GATEWAY_PUBLIC_SUFFIX || ".space-z.ai").toLowerCase();

/** Extra origins trusted for the CSRF same-site check (comma-separated). */
const TRUSTED_ORIGINS = (process.env.TRUSTED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function commaValues(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function urlSchemeOf(headerValue: string | null): string | null {
  if (!headerValue) return null;
  try {
    return new URL(headerValue).protocol.replace(":", "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the original (pre-proxy) client connection used HTTPS.
 *
 * Signal priority — positive signals win, because a misconfigured or
 * scheme-rewriting gateway may claim "http" while the browser is on HTTPS:
 *   1. X-Forwarded-Proto / RFC 7239 Forwarded proto=https (standard proxies)
 *   2. Origin / Referer scheme (set by the browser; web content cannot forge
 *      these headers — only a network attacker on a plain-HTTP hop could,
 *      and such an attacker is outside the CSRF/cookie threat model)
 *   3. Platform gateway marker (`abc` header only arrives via the public
 *      HTTPS gateway)
 *   4. Explicit "http" from a proxy header, else the request URL scheme.
 */
export function isSecureRequest(req?: Request): boolean {
  if (!req) return false;

  // 1. Standard proxy signals (trust an explicit https anywhere in the chain).
  if (commaValues(req.headers.get("x-forwarded-proto")).includes("https")) return true;
  const forwarded = req.headers.get("forwarded");
  if (forwarded && /proto\s*=\s*"?https"?/i.test(forwarded)) return true;

  // 2. The browser itself tells us the scheme the page was loaded over.
  for (const h of ["origin", "referer"]) {
    if (urlSchemeOf(req.headers.get(h)) === "https") return true;
  }

  // 3. Platform preview gateway marker.
  if (req.headers.get("abc")) return true;

  // 4. Fall back to what the hop directly in front of us claims.
  const proto = commaValues(req.headers.get("x-forwarded-proto"))[0];
  if (proto) return proto === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The set of hostnames this server is legitimately served under, derived
 * from proxy headers. The CSRF check accepts an Origin/Referer whose host
 * is in this set (scheme-agnostic — the host identity is what defines
 * "same site"; a same-host different-scheme origin can only be produced by
 * an attacker who already controls the hostname itself).
 */
export function allowedRequestHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string) => {
    const clean = h.trim().toLowerCase();
    if (clean) hosts.add(clean);
  };

  // Standard reverse-proxy headers (X-Forwarded-Host may be a comma chain).
  for (const v of commaValues(req.headers.get("x-forwarded-host"))) add(v);
  const host = req.headers.get("host");
  if (host) add(host);

  // RFC 7239 Forwarded header: Forwarded: for=…;host=example.com;proto=https
  const forwarded = req.headers.get("forwarded");
  if (forwarded) {
    for (const m of forwarded.matchAll(/host\s*=\s*"?([^";,]+)"?/gi)) add(m[1]);
  }

  // Platform preview gateway: `abc` carries the original public hostname
  // label (e.g. "preview-chat-<id>"); the public host is <abc><suffix>.
  const abc = req.headers.get("abc");
  if (abc) {
    const label = abc.trim().toLowerCase();
    add(label);
    add(`${label}${GATEWAY_PUBLIC_SUFFIX}`);
  }

  // Operator-configured extra origins (with or without scheme).
  for (const o of TRUSTED_ORIGINS) {
    try {
      add(new URL(o.includes("://") ? o : `https://${o}`).hostname);
    } catch {
      /* malformed entry — skip */
    }
  }

  return hosts;
}
