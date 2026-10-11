/**
 * Phase 17 — Privacy / data subject request workflow.
 * GET  /api/privacy-requests
 * POST /api/privacy-requests                       → create request (PENDING)
 * POST /api/privacy-requests/[id]/approve          → approve (owner-only)
 * POST /api/privacy-requests/[id]/execute          → execute (DESTRUCTIVE)
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createPrivacyRequest } from "@/lib/privacy";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError("Privacy requests are tenant-only.", 403, "FORBIDDEN");
    }
    const requests = await db.privacyRequest.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        requestedBy: true,
        approvedBy: true,
        legalReviewBy: true,
        retentionExpiresAt: true,
        completedAt: true,
        rejectionReason: true,
        auditSummary: true,
        createdAt: true,
      },
    });
    return jsonOk({ requests });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PRIVACY_REQUEST_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const type = typeof body.type === "string" ? body.type : "";
    if (!["EXPORT", "DELETE", "RECTIFY"].includes(type)) {
      return jsonError("type must be EXPORT, DELETE, or RECTIFY.", 422, "VALIDATION_ERROR");
    }
    const notes = typeof body.notes === "string" ? body.notes : undefined;
    const result = await createPrivacyRequest(auth.user, type as "EXPORT" | "DELETE" | "RECTIFY", notes);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "PRIVACY_ERROR");
    return jsonOk({ id: result.id }, 201);
  } catch (e) {
    return serverError(e);
  }
}
