/**
 * Phase 17 — Outbound webhook endpoint management.
 * GET  /api/webhooks          → list endpoints
 * POST /api/webhooks          → create endpoint (returns secret once)
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createWebhookEndpoint } from "@/lib/webhooks-out";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WEBHOOK_MANAGE");
    if (denied) return denied;
    const endpoints = await db.webhookEndpoint.findMany({
      where: { hotelId: auth.user.hotelId },
      select: {
        id: true,
        url: true,
        events: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    // Mask the secret — it's only returned at creation time.
    return jsonOk({ endpoints });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "WEBHOOK_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return jsonError("url is required.", 422, "VALIDATION_ERROR");
    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === "string") : [];
    const result = await createWebhookEndpoint(auth.user, url, events);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "WEBHOOK_ERROR");
    return jsonOk({ id: result.id, secret: result.secret, note: "Save the secret — it is shown only once." }, 201);
  } catch (e) {
    return serverError(e);
  }
}
