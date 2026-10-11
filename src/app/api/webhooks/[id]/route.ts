/**
 * Phase 17 — Webhook endpoint detail / delete / replay deliveries.
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WEBHOOK_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const endpoint = await db.webhookEndpoint.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!endpoint) return jsonError("Endpoint not found.", 404, "NOT_FOUND");
    const recentDeliveries = await db.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        eventId: true,
        eventType: true,
        attempt: true,
        status: true,
        responseStatus: true,
        deliveredAt: true,
        nextRetryAt: true,
        createdAt: true,
      },
    });
    return jsonOk({ endpoint, recentDeliveries });
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WEBHOOK_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const result = await db.webhookEndpoint.deleteMany({
      where: { id, hotelId: auth.user.hotelId },
    });
    if (result.count === 0) return jsonError("Endpoint not found.", 404, "NOT_FOUND");
    return jsonOk({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
