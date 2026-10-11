import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { archivePlan, updatePlan, validatePlanInput, type PlanInput } from "@/lib/saas/plans";

/**
 * Plan detail management — Phase 10 §2 (Super Admin only).
 *   PUT    /api/super-admin/plans/:id  → edit plan / prices / features / limits
 *   DELETE /api/super-admin/plans/:id  → archive (auto when dependencies exist)
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid request body.", 400, "BAD_REQUEST");
    const invalid = validatePlanInput(body as Partial<PlanInput>, true);
    if (invalid) return jsonError(invalid, 422, "VALIDATION_ERROR");
    const plan = await updatePlan(id, body as Partial<PlanInput>, guard.session.userId);
    return NextResponse.json({ plan: { id: plan.id, key: plan.key, name: plan.name } });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return jsonError(err.message, 404, "NOT_FOUND");
    }
    return serverError(err, "Could not update the plan.");
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const { id } = await ctx.params;
    const result = await archivePlan(id, guard.session.userId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return jsonError(err.message, 404, "NOT_FOUND");
    }
    return serverError(err, "Could not archive the plan.");
  }
}
