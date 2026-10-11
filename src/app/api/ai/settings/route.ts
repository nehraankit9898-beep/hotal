import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { getAISettings, logAIInteraction } from "@/lib/ai/governance";
import { logAudit } from "@/lib/audit";

/**
 * Phase 18 — tenant AI settings.
 *
 * GET   /api/ai/settings — AI_READ: current flags/caps (no secrets).
 * PATCH /api/ai/settings — OWNER/ADMIN only (the AI feature flags are the
 * governance switch — managers/marketing operate features, only the owner
 * turns them on). Body keys (all optional): chatbotEnabled,
 * chatbotServiceHours (JSON object or null), recommendationsEnabled,
 * forecastingEnabled, voiceEnabled, walletEnabled, sustainabilityEnabled,
 * modelProvider (only "NONE" accepted until a provider adapter is installed),
 * dailyRequestCap, monthlyRequestCap, handoffPhone.
 */

const SERVICE_HOURS_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function validateServiceHours(v: unknown): { ok: true; json: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "") return { ok: true, json: null };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false };
  const obj = v as Record<string, unknown>;
  for (const [day, windows] of Object.entries(obj)) {
    if (!SERVICE_HOURS_DAYS.includes(day)) return { ok: false };
    if (!Array.isArray(windows)) return { ok: false };
    for (const w of windows) {
      const win = w as { open?: unknown; close?: unknown };
      if (typeof win.open !== "string" || typeof win.close !== "string") return { ok: false };
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(win.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(win.close)) {
        return { ok: false };
      }
    }
  }
  return { ok: true, json: JSON.stringify(obj) };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const settings = await getAISettings(auth.user.hotelId);
    return Response.json({ settings });
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    // Governance switches are owner/admin territory.
    if (auth.user.role !== "HOTEL_OWNER" && auth.user.role !== "HOTEL_ADMIN") {
      return jsonError("Only the owner/admin can change AI settings.", 403, "FORBIDDEN");
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    await getAISettings(auth.user.hotelId); // ensure row exists
    const data: Record<string, unknown> = {};

    if (typeof body.chatbotEnabled === "boolean") data.chatbotEnabled = body.chatbotEnabled;
    if (typeof body.recommendationsEnabled === "boolean") data.recommendationsEnabled = body.recommendationsEnabled;
    if (typeof body.forecastingEnabled === "boolean") data.forecastingEnabled = body.forecastingEnabled;
    if (typeof body.voiceEnabled === "boolean") data.voiceEnabled = body.voiceEnabled;
    if (typeof body.walletEnabled === "boolean") data.walletEnabled = body.walletEnabled;
    if (typeof body.sustainabilityEnabled === "boolean") data.sustainabilityEnabled = body.sustainabilityEnabled;

    if ("chatbotServiceHours" in body) {
      const hours = validateServiceHours(body.chatbotServiceHours);
      if (!hours.ok) return jsonError("Invalid service hours format.", 422, "INVALID_SERVICE_HOURS");
      data.chatbotServiceHours = hours.json;
    }

    if ("modelProvider" in body) {
      // HONEST POLICY: until a real provider adapter + credentials exist,
      // "NONE" (rule-based only) is the only value this API accepts.
      if (body.modelProvider !== "NONE") {
        return jsonError(
          "Only modelProvider 'NONE' (rule-based) is currently supported. External providers require a configured adapter and credentials.",
          422,
          "PROVIDER_NOT_AVAILABLE",
        );
      }
      data.modelProvider = "NONE";
    }

    if ("dailyRequestCap" in body) {
      const cap = Number(body.dailyRequestCap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 100_000) {
        return jsonError("dailyRequestCap must be an integer 1..100000.", 422, "INVALID_CAP");
      }
      data.dailyRequestCap = cap;
    }
    if ("monthlyRequestCap" in body) {
      const cap = Number(body.monthlyRequestCap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 1_000_000) {
        return jsonError("monthlyRequestCap must be an integer 1..1000000.", 422, "INVALID_CAP");
      }
      data.monthlyRequestCap = cap;
    }
    if ("handoffPhone" in body) {
      if (body.handoffPhone === null || body.handoffPhone === "") data.handoffPhone = null;
      else if (typeof body.handoffPhone === "string" && /^\+?[0-9]{7,15}$/.test(body.handoffPhone.trim())) {
        data.handoffPhone = body.handoffPhone.trim();
      } else return jsonError("handoffPhone must be digits with optional + (7-15 chars).", 422, "INVALID_PHONE");
    }

    if (Object.keys(data).length === 0) {
      return jsonError("No valid fields to update.", 400, "NO_CHANGES");
    }

    await db.aISettings.update({ where: { hotelId: auth.user.hotelId }, data: data as never });

    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "AI_SETTINGS_UPDATED",
      entityType: "ai_settings",
      entityId: auth.user.hotelId,
      metadata: { changes: Object.keys(data) },
    });
    await logAIInteraction({
      hotelId: auth.user.hotelId, kind: "CHATBOT", subtype: "SETTINGS_UPDATED",
      status: "OK", meta: { changes: Object.keys(data) },
    });

    const settings = await getAISettings(auth.user.hotelId);
    return Response.json({ settings });
  } catch (err) {
    return serverError(err);
  }
}
