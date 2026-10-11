/**
 * Phase 17 — Franchise / chain management API.
 *
 * GET    /api/franchise                  → list organizations the caller administers
 * POST   /api/franchise                  → create a new organization
 * GET    /api/franchise/[id]             → organization summary + branches
 * POST   /api/franchise/[id]/branches   → add a branch to the organization
 * POST   /api/franchise/[id]/templates   → publish a new menu template version
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import {
  createFranchise,
  getFranchiseBranchSummary,
  addBranchToFranchise,
} from "@/lib/franchise";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "FRANCHISE_MANAGE");
    if (denied) return denied;

    const orgs = await db.franchiseOrganizationAdmin.findMany({
      where: { userId: auth.user.userId },
      include: { org: { select: { id: true, name: true, active: true, currency: true } } },
    });
    return jsonOk({ organizations: orgs.map((a) => ({ ...a.org, role: a.role })) });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "FRANCHISE_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const name = typeof body.name === "string" ? body.name : "";
    if (!name) return jsonError("Organization name is required.", 422, "VALIDATION_ERROR");
    const legalName = typeof body.legalName === "string" ? body.legalName : undefined;
    const taxId = typeof body.taxId === "string" ? body.taxId : undefined;
    const result = await createFranchise(auth.user, name, legalName, taxId);
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "FRANCHISE_ERROR");
    return jsonOk({ id: result.id }, 201);
  } catch (e) {
    return serverError(e);
  }
}
