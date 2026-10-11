import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-helpers";
import { listPublicPlans } from "@/lib/saas/plans";

/**
 * GET /api/pricing — PUBLIC plan catalogue (Phase 10 §2).
 *
 * The frontend pricing/upgrade UI ALWAYS loads prices from this endpoint —
 * prices are never hardcoded in client code. Only active, public, non-
 * archived plans are exposed; internal ids/secrets never leave.
 */
export async function GET() {
  try {
    const plans = await listPublicPlans();
    return NextResponse.json(
      { plans },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    );
  } catch (err) {
    return serverError(err, "Could not load pricing right now.");
  }
}
