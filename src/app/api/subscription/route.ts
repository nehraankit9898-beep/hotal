import { NextResponse } from "next/server";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { getSubscriptionView } from "@/lib/saas/subscriptions";
import { getUsageSummary } from "@/lib/saas/limits";
import { listHotelPayments } from "@/lib/saas/billing";

/**
 * GET /api/subscription — the tenant's own subscription + trial + usage +
 * payment history (Phase 10 §4 trial dashboard, §5 backend verification).
 * Available to signed-in hotel users (read-only, self-scoped).
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if ("response" in auth) return auth.response;
  if (auth.user.role === "SUPER_ADMIN") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Super admin has no tenant subscription." } },
      { status: 403 },
    );
  }
  try {
    const [subscription, usage, payments] = await Promise.all([
      getSubscriptionView(auth.user.hotelId),
      getUsageSummary(auth.user.hotelId),
      listHotelPayments(auth.user.hotelId),
    ]);
    return NextResponse.json({ subscription, usage, payments });
  } catch (err) {
    return serverError(err, "Could not load your subscription.");
  }
}
