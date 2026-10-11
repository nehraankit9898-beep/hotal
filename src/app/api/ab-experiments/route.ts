/**
 * Phase 17 — A/B experiment management.
 * GET  /api/ab-experiments
 * POST /api/ab-experiments          → create experiment
 * POST /api/ab-experiments/[id]/kill → emergency kill switch
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      // Super Admin can read all experiments (platform-wide).
      const all = await db.aBExperiment.findMany({
        orderBy: { createdAt: "desc" },
        select: { id: true, key: true, name: true, active: true, killSwitch: true, startedAt: true, endedAt: true },
      });
      return jsonOk({ experiments: all });
    }
    // Tenant experiments are platform-wide too (single-tenant for MVP);
    // but management permission gates mutation only.
    const all = await db.aBExperiment.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, key: true, name: true, active: true, killSwitch: true, startedAt: true, endedAt: true },
    });
    return jsonOk({ experiments: all });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AB_EXPERIMENT_MANAGE");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const variants = Array.isArray(body.variants) ? body.variants.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
    if (!key || !name || variants.length < 2) {
      return jsonError("key, name, and at least 2 variants are required.", 422, "VALIDATION_ERROR");
    }
    // Default equal weights.
    const weights = new Array(variants.length).fill(1 / variants.length);
    const created = await db.aBExperiment.create({
      data: {
        key,
        name,
        description: typeof body.description === "string" ? body.description : null,
        variants: JSON.stringify(variants),
        weights: JSON.stringify(weights),
        active: false, // explicitly opt-in
        createdByUserId: auth.user.userId,
      },
      select: { id: true, key: true },
    });
    return jsonOk({ id: created.id, key: created.key }, 201);
  } catch (e) {
    return serverError(e);
  }
}
