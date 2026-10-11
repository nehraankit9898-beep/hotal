import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireAuth } from "@/lib/api-helpers";
import { createCheckout } from "@/lib/saas/billing";
import { checkRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/login-security";

/**
 * POST /api/billing/checkout — start a plan purchase/upgrade (Phase 10 §6).
 *   { planKey, billingCycle: "MONTHLY"|"YEARLY", couponCode? }
 * Only tenant admins/owners may purchase; staff roles get 403 via permission
 * check. Rate-limited; fully audited; idempotent per hour.
 */
export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  if (auth.user.role !== "HOTEL_OWNER" && auth.user.role !== "HOTEL_ADMIN") {
    return jsonError("Only hotel owners/admins can manage billing.", 403, "FORBIDDEN");
  }
  try {
    const ip = requestIp(req);
    const burst = await checkRateLimit(`checkout:${auth.user.hotelId}:${ip}`, 10, 60 * 60 * 1000);
    if (!burst.allowed) {
      return jsonError("Too many checkout attempts. Please try again later.", 429, "RATE_LIMITED");
    }
    const body = await readJson(req);
    const planKey = typeof body?.planKey === "string" ? body.planKey.trim() : "";
    const billingCycle = body?.billingCycle === "YEARLY" ? "YEARLY" : "MONTHLY";
    const couponCode =
      typeof body?.couponCode === "string" ? body.couponCode.trim().toUpperCase() : null;
    if (!/^[a-z0-9_-]{2,40}$/i.test(planKey)) {
      return jsonError("A valid plan is required.", 422, "VALIDATION_ERROR");
    }
    const result = await createCheckout({
      hotelId: auth.user.hotelId,
      planKey,
      billingCycle,
      couponCode,
      userId: auth.user.userId,
    });
    if ("error" in result) return jsonError(result.error, 400, "CHECKOUT_FAILED");
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return serverError(err, "Could not start checkout. Please try again.");
  }
}
