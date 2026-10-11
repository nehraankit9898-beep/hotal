/**
 * Phase 17 — Super Admin: SaaS refunds.
 * GET  /api/super-admin/refunds          → list all subscription refunds
 * POST /api/super-admin/refunds          → initiate a refund (idempotent)
 */
import { NextResponse } from "next/server";
import { requireSuperAdminSession, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { initiateSubscriptionRefund } from "@/lib/saas/refunds";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const auth = await requireSuperAdminSession(req);
    if ("response" in auth) return auth.response;
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const refunds = await db.subscriptionRefund.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        hotelId: true,
        paymentId: true,
        providerRefundId: true,
        amountMinor: true,
        currency: true,
        status: true,
        reason: true,
        initiatedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return jsonOk({ refunds });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireSuperAdminSession(req);
    if ("response" in auth) return auth.response;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const hotelId = typeof body.hotelId === "string" ? body.hotelId : "";
    const amountMinor = typeof body.amountMinor === "number" ? body.amountMinor : NaN;
    const reason = typeof body.reason === "string" ? body.reason : "";
    const initiatedBy = typeof body.initiatedBy === "string" ? body.initiatedBy : "";
    if (!hotelId || !isFinite(amountMinor) || amountMinor <= 0 || !reason || !initiatedBy) {
      return jsonError("hotelId, amountMinor (>0), reason, initiatedBy are required.", 422, "VALIDATION_ERROR");
    }
    const result = await initiateSubscriptionRefund({
      hotelId,
      paymentId: typeof body.paymentId === "string" ? body.paymentId : null,
      amountMinor,
      currency: typeof body.currency === "string" ? body.currency : "INR",
      reason,
      initiatedBy,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      isManual: body.isManual === true,
    });
    return jsonOk(result, 201);
  } catch (e) {
    return serverError(e);
  }
}
