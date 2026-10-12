import { checkRateLimit, clientIp } from "@/lib/rate-limit";

/** Public payment endpoints share the production Redis limiter. Per-IP keys
 * must come from the trusted proxy chain (clientIp), never request bodies. */
export async function limitPaymentLinkRequest(req: Request, action: "read" | "checkout" | "verify") {
  const limits = { read: 60, checkout: 10, verify: 30 } as const;
  const result = await checkRateLimit(`payment-link:${action}:${clientIp(req)}`, limits[action], 60_000);
  if (result.allowed) return null;
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}
