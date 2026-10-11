/**
 * Phase 17 — Super Admin: Secret rotation audit.
 * GET  /api/super-admin/secret-rotations          → list recent rotations
 * POST /api/super-admin/secret-rotations           → record a rotation event
 */
import { NextResponse } from "next/server";
import { requireSuperAdminSession, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { recordSecretRotation, listRecentRotations } from "@/lib/secret-rotation";

export async function GET(req: Request) {
  try {
    const auth = await requireSuperAdminSession(req);
    if ("response" in auth) return auth.response;
    const rotations = await listRecentRotations(100);
    return jsonOk({ rotations });
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
    const secretKey = typeof body.secretKey === "string" ? body.secretKey : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    const oldValue = typeof body.oldValue === "string" ? body.oldValue : "";
    const newValue = typeof body.newValue === "string" ? body.newValue : "";
    if (!secretKey || !reason || !oldValue || !newValue) {
      return jsonError("secretKey, reason, oldValue, newValue are required.", 422, "VALIDATION_ERROR");
    }
    const performedBy = typeof body.performedBy === "string" ? body.performedBy : undefined;
    const notes = typeof body.notes === "string" ? body.notes : undefined;
    const result = await recordSecretRotation({
      secretKey,
      reason: reason as "SCHEDULED" | "COMPROMISE" | "KEY_EXPIRY" | "MANUAL",
      performedBy,
      oldValue,
      newValue,
      notes,
    });
    return jsonOk(result, 201);
  } catch (e) {
    return serverError(e);
  }
}
