import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { getLoyaltySettings } from "@/lib/loyalty";

/**
 * Restaurant settings API — Phase 6.3 (spec §45)
 * GET /api/settings  — marketing frequency, consent text, feedback toggle
 * PUT /api/settings  — update (admin-only via SETTINGS_MANAGE, audited)
 *
 * Phase 8.1 §7 — these routes are HOTEL-SCOPED. SUPER_ADMIN (hotelId = "")
 * is explicitly DENIED: no hotel-settings access, and no accidental creation
 * of HotelSettings rows with hotelId = "". Platform configuration is owned by
 * /api/super-admin/* endpoints only.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError(
        "Hotel settings are not available to the platform super admin.",
        403,
        "FORBIDDEN",
      );
    }
    const denied = requirePermission(auth.user, "LOYALTY_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;
    if (!hotelId) return jsonError("Hotel context is required.", 403, "FORBIDDEN");

    let settings = await db.hotelSettings.findUnique({ where: { hotelId } });
    if (!settings) {
      settings = await db.hotelSettings.create({ data: { hotelId } });
    }
    const loyalty = await getLoyaltySettings(hotelId);

    return Response.json({
      settings: {
        marketingFrequencyLimit: settings.marketingFrequencyLimit,
        frequencyWindowDays: settings.frequencyWindowDays,
        consentText: settings.consentText,
        feedbackEnabled: settings.feedbackEnabled,
      },
      loyalty: {
        enabled: loyalty.enabled,
        mode: loyalty.mode,
      },
      restaurant: {
        name: auth.user.hotelName,
      },
    });
  } catch (err) {
    return serverError(err, "Settings could not be loaded.");
  }
}

export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "SUPER_ADMIN") {
      return jsonError(
        "Hotel settings are not available to the platform super admin.",
        403,
        "FORBIDDEN",
      );
    }
    const denied = requirePermission(auth.user, "SETTINGS_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    if (!hotelId) return jsonError("Hotel context is required.", 403, "FORBIDDEN");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const freq = Math.round(Number(body.marketingFrequencyLimit));
    const windowDays = Math.round(Number(body.frequencyWindowDays));
    const consentText = typeof body.consentText === "string" ? body.consentText.trim() : null;

    const data: Record<string, unknown> = {};
    if (body.marketingFrequencyLimit !== undefined) {
      if (!Number.isFinite(freq) || freq < 1 || freq > 50) {
        return jsonError("Marketing frequency limit must be between 1 and 50 messages.");
      }
      data.marketingFrequencyLimit = freq;
    }
    if (body.frequencyWindowDays !== undefined) {
      if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 365) {
        return jsonError("Frequency window must be between 1 and 365 days.");
      }
      data.frequencyWindowDays = windowDays;
    }
    if (consentText !== null) {
      if (consentText.length < 10 || consentText.length > 300) {
        return jsonError("Consent text must be 10–300 characters.");
      }
      data.consentText = consentText;
    }
    if (typeof body.feedbackEnabled === "boolean") {
      data.feedbackEnabled = body.feedbackEnabled;
    }
    if (Object.keys(data).length === 0) {
      return jsonError("Nothing to update.");
    }

    const updated = await db.hotelSettings.upsert({
      where: { hotelId },
      create: { hotelId, ...data },
      update: data,
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.RESTAURANT_SETTINGS_UPDATED,
      entityType: "hotel_settings",
      entityId: updated.id,
      metadata: {
        marketingFrequencyLimit: updated.marketingFrequencyLimit,
        frequencyWindowDays: updated.frequencyWindowDays,
        feedbackEnabled: updated.feedbackEnabled,
      },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Settings could not be updated.");
  }
}
