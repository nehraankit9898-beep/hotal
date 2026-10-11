import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { createPlan, listAllPlans, validatePlanInput, type PlanInput } from "@/lib/saas/plans";

/**
 * Plans & Pricing management — Phase 10 §2/§3 (Super Admin only).
 *   GET  /api/super-admin/plans   → all plans incl. usage counts
 *   POST /api/super-admin/plans   → create unlimited custom plans
 * Prices are stored in the DB — the frontend NEVER hardcodes them.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const plans = await listAllPlans();
    return NextResponse.json({ plans });
  } catch (err) {
    return serverError(err, "Could not load plans.");
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    if (!body) return jsonError("Invalid request body.", 400, "BAD_REQUEST");
    const invalid = validatePlanInput(body as Partial<PlanInput>);
    if (invalid) return jsonError(invalid, 422, "VALIDATION_ERROR");
    const plan = await createPlan(body as unknown as PlanInput, guard.session.userId);
    return NextResponse.json(
      { plan: { id: plan.id, key: plan.key, name: plan.name } },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && /already exists/i.test(err.message)) {
      return jsonError(err.message, 409, "CONFLICT");
    }
    return serverError(err, "Could not create the plan.");
  }
}
