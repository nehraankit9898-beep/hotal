import { db } from "@/lib/db";
import { timingSafeEqual } from "crypto";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { ensureFollowUpSteps, latestCheckoutByCustomer, runFollowUpEngine } from "@/lib/campaigns";
import { hotelTimezone, sameZonedDay } from "@/lib/timezone";
import { getFollowUpEngineSecret } from "@/lib/config";

import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * GET  /api/campaigns/run-engine — engine status (steps + eligibility preview)
 * POST /api/campaigns/run-engine — run the Smart Follow-up Engine now.
 *
 * Cron invocation (Phase 7 hardened): signed request with
 *   X-Engine-Signature = base64url(HMAC-SHA256(FOLLOWUP_ENGINE_SECRET, "<ts>.<body>"))
 *   X-Engine-Timestamp = unix seconds
 * Query-string secrets (?secret=) are no longer accepted.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const steps = await ensureFollowUpSteps(hotelId);
    const now = new Date();

    // Eligibility preview: customers whose latest completed stay checked out N days ago.
    // Same hotel-timezone, DB-aggregated logic as the engine (no full table load).
    const tz = await hotelTimezone(hotelId);
    const latestByCustomer = await latestCheckoutByCustomer(hotelId);

    return Response.json({
      steps: steps.map((s) => {
        const targetDay = new Date(now.getTime() - s.offsetDays * 24 * 60 * 60 * 1000);
        const eligible = [...latestByCustomer.values()].filter((c) =>
          sameZonedDay(c, targetDay, tz),
        ).length;
        return {
          id: s.id,
          offsetDays: s.offsetDays,
          label: s.label,
          messageTemplate: s.messageTemplate,
          channels: JSON.parse(s.channels) as string[],
          enabled: s.enabled,
          eligibleToday: eligible,
        };
      }),
    });
  } catch (err) {
    return serverError(err, "Follow-up engine settings could not be loaded. Please try again.");
  }
}

export async function POST(req: Request) {
  try {
    const engineSecret = getFollowUpEngineSecret();

    // Cron path: no session — HMAC-signed request (header-only, never query string).
    if (engineSecret) {
      const signature = req.headers.get("x-engine-signature");
      const timestamp = req.headers.get("x-engine-timestamp");
      if (signature && timestamp) {
        const rawBody = await req.text();
        const { signWebhookPayload } = await import("@/lib/webhook-verify");
        const expected = signWebhookPayload(engineSecret, timestamp, rawBody);
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        const skew = Math.abs(Date.now() - Number(timestamp) * 1000);
        const valid =
          /^\d{1,13}$/.test(timestamp) &&
          a.length === b.length &&
          a.length > 0 &&
          timingSafeEqual(a, b) &&
          skew <= 5 * 60 * 1000;
        if (!valid) {
          return jsonError("Invalid engine signature.", 401, "INVALID_SIGNATURE");
        }

        const hotels = await db.hotel.findMany({ where: { status: "ACTIVE" } });
        const results: Awaited<ReturnType<typeof runFollowUpEngine>>[] = [];
        for (const hotel of hotels) {
          results.push(await runFollowUpEngine(hotel.id, hotel.name, null));
        }
        await logAudit({
          req,
          action: AUDIT_ACTIONS.FOLLOWUP_ENGINE_RUN,
          metadata: { cron: true, hotels: hotels.length },
        });
        return Response.json({
          ok: true,
          cron: true,
          hotels: results.length,
          totals: results.reduce(
            (acc, r) => ({
              stepsProcessed: acc.stepsProcessed + r.stepsProcessed,
              customersProcessed: acc.customersProcessed + r.customersProcessed,
              sent: acc.sent + r.sent,
              failed: acc.failed + r.failed,
              skipped: acc.skipped + r.skipped,
            }),
            { stepsProcessed: 0, customersProcessed: 0, sent: 0, failed: 0, skipped: 0 },
          ),
        });
      }
    }

    // Session path.
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_SEND");
    if (denied) return denied;

    const result = await runFollowUpEngine(
      auth.user.hotelId,
      auth.user.hotelName,
      auth.user.userId,
    );

    return Response.json({ ok: true, result });
  } catch (err) {
    return serverError(err, "The follow-up engine could not run. Please try again.");
  }
}
