import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { getSettings, setSetting, DEFAULT_SETTINGS, type SettingKey } from "@/lib/saas/settings";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Platform settings — Phase 10 §1 (Super Admin only).
 *   GET /api/super-admin/settings                 → all SaaS control values
 *   PUT /api/super-admin/settings                 → { key, value } typed update
 * Allowed keys are whitelisted — the DB is the source of truth and every
 * change changes actual application behaviour + is audited.
 */
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const settings = await getSettings(SETTING_KEYS);
    return NextResponse.json({ settings });
  } catch (err) {
    return serverError(err, "Could not load platform settings.");
  }
}

export async function PUT(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const key = typeof body?.key === "string" ? (body.key as SettingKey) : null;
    if (!key || !SETTING_KEYS.includes(key)) {
      return jsonError("Unknown setting key.", 422, "VALIDATION_ERROR");
    }
    if (body?.value === undefined) {
      return jsonError("A value is required.", 422, "VALIDATION_ERROR");
    }
    // Validate shape per key (defence in depth on top of DB JSON storage).
    const value = body.value;
    if (key === "trial.defaults") {
      const d = value as Record<string, unknown>;
      if (Number(d?.defaultDays) < 0 || Number(d?.defaultDays) > 365)
        return jsonError("Default trial days must be 0-365.", 422, "VALIDATION_ERROR");
      if (Number(d?.minDays) < 0 || Number(d?.minDays) > 90)
        return jsonError("Minimum trial days must be 0-90.", 422, "VALIDATION_ERROR");
      if (Number(d?.maxDays) < 1 || Number(d?.maxDays) > 365)
        return jsonError("Maximum trial days must be 1-365.", 422, "VALIDATION_ERROR");
      if (Number(d?.minDays) > Number(d?.maxDays))
        return jsonError("Minimum trial days cannot exceed the maximum.", 422, "VALIDATION_ERROR");
      if (Number(d?.graceDays) < 0 || Number(d?.graceDays) > 90)
        return jsonError("Grace days must be 0-90.", 422, "VALIDATION_ERROR");
      if (d?.defaultPlanKey !== undefined && !/^[a-z0-9_-]{0,40}$/i.test(String(d.defaultPlanKey)))
        return jsonError("Invalid default trial plan key.", 422, "VALIDATION_ERROR");
    }
    if (key === "mfa.policy") {
      const p = value as Record<string, unknown>;
      if (!Array.isArray(p?.requiredRoles))
        return jsonError("requiredRoles must be a list of roles.", 422, "VALIDATION_ERROR");
      const validRoles = [
        "SUPER_ADMIN",
        "HOTEL_OWNER",
        "HOTEL_ADMIN",
        "HOTEL_MANAGER",
        "MARKETING_MANAGER",
        "RESTAURANT_MANAGER",
        "FRONT_DESK",
        "HOTEL_STAFF",
      ];
      if ((p.requiredRoles as string[]).some((r) => !validRoles.includes(r))) {
        return jsonError("Invalid role in requiredRoles.", 422, "VALIDATION_ERROR");
      }
    }
    if (key === "security") {
      const s = value as Record<string, unknown>;
      if (!Array.isArray(s?.blockedIps))
        return jsonError("blockedIps must be a list.", 422, "VALIDATION_ERROR");
    }
    await setSetting(key, value as never, { userId: guard.session.userId, req });
    if (key === "maintenance") {
      const m = value as { enabled: boolean };
      await logAudit({
        userId: guard.session.userId,
        action: AUDIT_ACTIONS.MAINTENANCE_MODE_CHANGED,
        entityType: "platform_setting",
        entityId: "maintenance",
        metadata: { enabled: m.enabled },
        req,
      });
    }
    if (key === "mfa.policy") {
      await logAudit({
        userId: guard.session.userId,
        action: AUDIT_ACTIONS.MFA_POLICY_CHANGED,
        entityType: "platform_setting",
        entityId: "mfa.policy",
        metadata: { requiredRoles: (value as { requiredRoles: string[] }).requiredRoles },
        req,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "Could not update the setting.");
  }
}
