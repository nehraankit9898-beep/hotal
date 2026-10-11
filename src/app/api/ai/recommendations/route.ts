import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { generateRecommendations } from "@/lib/ai/recommendations";

/**
 * Phase 18 — RULE_BASED offer recommendations (human approval REQUIRED).
 *
 * GET  /api/ai/recommendations?status=PENDING — list (AI_READ).
 * POST /api/ai/recommendations — generate candidates (AI_MANAGE). NEVER sends
 * anything by itself; approvals happen one-by-one on the detail endpoints.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const validStatus = ["PENDING", "APPROVED", "SENT", "DISMISSED", "EXPIRED"].includes(status ?? "")
      ? (status as string)
      : undefined;
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100), 500);

    const recommendations = await db.aIRecommendation.findMany({
      where: { hotelId: auth.user.hotelId, ...(validStatus ? { status: validStatus } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        coupon: { select: { id: true, code: true, discountType: true, discountValue: true } },
      },
    });

    return Response.json({
      recommendations: recommendations.map((r) => ({
        id: r.id,
        basis: r.basis, // always RULE_BASED today — displayed as such
        ruleId: r.ruleId,
        reasonCode: r.reasonCode,
        score: r.score,
        status: r.status,
        channel: r.channel,
        customer: r.customer ? { id: r.customer.id, name: r.customer.name } : null,
        coupon: r.coupon ? { code: r.coupon.code, discountType: r.coupon.discountType, discountValue: r.coupon.discountValue } : null,
        approvedAt: r.approvedAt,
        sentAt: r.sentAt,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const body = (await readJson(req)) ?? {};
    const limit = Math.min(Math.max(1, Number(body.limit ?? 50) || 50), 200);

    const result = await generateRecommendations(auth.user.hotelId, { limit });
    return Response.json({
      created: result.created,
      skippedExisting: result.skippedExisting,
      basis: "RULE_BASED",
      note: "Candidates are PENDING — nothing is sent until a human approves each one.",
    });
  } catch (err) {
    return serverError(err);
  }
}
