import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { subscriptionAction } from "@/lib/saas/subscriptions";
import { logSecurityEvent } from "@/lib/saas/security";

/**
 * Subscription lifecycle actions — Phase 10 §5 (Super Admin only).
 * POST /api/super-admin/subscriptions/action
 *   { subscriptionId, action, reason?, planId?, days? }
 * High-impact operations REQUIRE a reason (audited with before/after).
 */
const ACTIONS = new Set([
  "activate",
  "reactivate",
  "change-plan",
  "extend-trial",
  "start-trial",
  "cancel",
  "suspend",
  "pause",
  "resume",
]);
const DANGEROUS = new Set(["cancel", "suspend", "change-plan"]);

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const subscriptionId = typeof body?.subscriptionId === "string" ? body.subscriptionId : "";
    const action = typeof body?.action === "string" ? body.action : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const planId = typeof body?.planId === "string" ? body.planId : undefined;
    const days = Number.isFinite(Number(body?.days)) ? Number(body?.days) : undefined;

    if (!subscriptionId || !ACTIONS.has(action)) {
      return jsonError("subscriptionId and a valid action are required.", 422, "VALIDATION_ERROR");
    }
    if (DANGEROUS.has(action) && reason.length < 3) {
      return jsonError(
        "A reason is required for destructive subscription operations.",
        422,
        "REASON_REQUIRED",
      );
    }
    const sub = await subscriptionAction(action, subscriptionId, guard.session.userId, {
      reason: reason || undefined,
      planId,
      days,
    });
    if (DANGEROUS.has(action)) {
      await logSecurityEvent({
        type: "SUSPICIOUS_ACTIVITY",
        severity: "WARNING",
        userId: guard.session.userId,
        details: { action, subscriptionId, reason },
      });
    }
    return NextResponse.json({
      subscription: { id: sub.id, status: sub.status, planId: sub.planId },
    });
  } catch (err) {
    if (err instanceof Error) {
      if (/not found/i.test(err.message)) return jsonError(err.message, 404, "NOT_FOUND");
      if (/Unknown subscription action/i.test(err.message))
        return jsonError(err.message, 422, "VALIDATION_ERROR");
      return jsonError(err.message, 400, "SUBSCRIPTION_ACTION_FAILED");
    }
    return serverError(err, "Could not perform the subscription action.");
  }
}
