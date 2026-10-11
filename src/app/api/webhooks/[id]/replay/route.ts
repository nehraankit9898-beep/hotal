/**
 * Phase 17 — Replay a dead-lettered webhook delivery.
 * POST /api/webhooks/[id]/replay { deliveryId } — re-enqueues the delivery
 * for immediate retry.
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WEBHOOK_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
    if (!deliveryId) return jsonError("deliveryId is required.", 422, "VALIDATION_ERROR");
    // Verify the delivery belongs to one of the caller's endpoints.
    const delivery = await db.webhookDelivery.findFirst({
      where: { id: deliveryId, endpoint: { id, hotelId: auth.user.hotelId } },
    });
    if (!delivery) return jsonError("Delivery not found.", 404, "NOT_FOUND");
    if (delivery.status === "DELIVERED") {
      return jsonError("Delivery already completed — nothing to replay.", 409, "ALREADY_DELIVERED");
    }
    // Reset and schedule for immediate retry.
    await db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: "PENDING", nextRetryAt: new Date(), attempt: 0 },
    });
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
