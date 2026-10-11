/**
 * Phase 17 — Emergency kill switch for an A/B experiment.
 * POST /api/ab-experiments/[id]/kill { active: false }
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { setKillSwitch } from "@/lib/ab-testing";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AB_EXPERIMENT_MANAGE");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await readJson(req);
    const on = typeof body?.on === "boolean" ? body.on : true;
    const newKill = await setKillSwitch(id, on);
    return jsonOk({ killSwitch: newKill });
  } catch (e) {
    return serverError(e);
  }
}
