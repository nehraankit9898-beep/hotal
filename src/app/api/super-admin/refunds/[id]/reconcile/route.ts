/**
 * Phase 17 — Reconcile a subscription refund with the provider's response.
 * POST /api/super-admin/refunds/[id]/reconcile { providerRefundId, succeeded, failureReason }
 */
import { NextResponse } from "next/server";
import { requireSuperAdminSession, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { reconcileSubscriptionRefund } from "@/lib/saas/refunds";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireSuperAdminSession(req);
    if ("response" in auth) return auth.response;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const providerRefundId = typeof body.providerRefundId === "string" ? body.providerRefundId : null;
    const succeeded = body.succeeded === true;
    const failureReason = typeof body.failureReason === "string" ? body.failureReason : undefined;
    await reconcileSubscriptionRefund(id, providerRefundId, succeeded, failureReason);
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
