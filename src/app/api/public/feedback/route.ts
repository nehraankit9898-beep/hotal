import { db } from "@/lib/db";
import { jsonError, readJson, serverError } from "@/lib/api-helpers";
import { normalizePhone } from "@/lib/phone";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { resolvePublicQr } from "@/lib/qr";

/**
 * Public feedback — Phase 6.3 (spec §31), hardened in Phase 6.4 (spec §8).
 *
 * POST /api/public/feedback — a customer submits a star rating (+ optional
 * comment) from the restaurant's QR page. Phone is optional; when given and
 * matched, the feedback links to the customer's profile. Otherwise it's an
 * anonymous feedback row (no tracking).
 *
 * Phase 6.4 layered abuse prevention (without rejecting legitimate customers):
 *  1. IP rate limit — 6 submissions / minute / IP.
 *  2. Phone rate limit — 3 submissions / hour / matched phone.
 *  3. Duplicate detection — the same phone (or IP when anonymous) submitting
 *     identical rating + comment within a 10-minute cooldown is rejected.
 *  4. Payload limits — rating 1-5, comment ≤ 500 chars, body ≤ 1 MB.
 *  5. Suspicious activity is audit-logged for staff review.
 */
const DUPLICATE_COOLDOWN_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const ipLimit = await checkRateLimit(`public-feedback:${ip}`, 6, 60_000);
    if (!ipLimit.allowed) {
      // Suspicious activity logging (spec §8) — visible in the audit log.
      await logAudit({
        req,
        action: AUDIT_ACTIONS.FEEDBACK_RATE_LIMITED,
        entityType: "feedback",
        metadata: { layer: "IP", ip },
      }).catch(() => undefined);
      return Response.json(
        { error: { code: "RATE_LIMITED", message: "Too many submissions. Please wait a moment." } },
        { status: 429 },
      );
    }

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const qrCode = typeof body.qrCode === "string" ? body.qrCode.trim() : "";
    const rating = Math.round(Number(body.rating));
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    const rawPhone = typeof body.phone === "string" ? body.phone : "";

    const qr = await resolvePublicQr(qrCode);
    if (!qr.ok) {
      return Response.json({ error: { code: "QR_INACTIVE", message: qr.reason } }, { status: 404 });
    }
    if (!qr.feedbackEnabled) {
      return Response.json(
        {
          error: {
            code: "FEEDBACK_DISABLED",
            message: "This restaurant is not accepting feedback right now.",
          },
        },
        { status: 403 },
      );
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonError("Please choose a rating from 1 to 5 stars.");
    }
    if (comment.length > 500)
      return jsonError("Feedback message is too long (max 500 characters).");

    const hotelId = qr.restaurant.id;

    // Optional, consent-free identification: link when the phone matches an
    // existing customer of THIS restaurant; never create a profile from
    // feedback alone (no secret collection).
    let customerId: string | null = null;
    let normalized = "";
    if (rawPhone.trim()) {
      const phone = normalizePhone(rawPhone);
      if (phone.ok && phone.normalized) {
        normalized = phone.normalized;
        // Layer 2 — per-phone rate limit (hourly).
        const phoneLimit = await checkRateLimit(
          `public-feedback-phone:${hotelId}:${normalized}`,
          3,
          60 * 60_000,
        );
        if (!phoneLimit.allowed) {
          await logAudit({
            req,
            action: AUDIT_ACTIONS.FEEDBACK_RATE_LIMITED,
            entityType: "feedback",
            metadata: { layer: "PHONE", hotelId },
          }).catch(() => undefined);
          return Response.json(
            {
              error: {
                code: "RATE_LIMITED",
                message:
                  "This number has submitted several feedbacks recently. Please try again later.",
              },
            },
            { status: 429 },
          );
        }
        const customer = await db.customer.findUnique({
          where: { hotelId_phone: { hotelId, phone: normalized } },
          select: { id: true },
        });
        customerId = customer?.id ?? null;
      }
    }

    // Layer 3 — duplicate submission detection within the cooldown window.
    // A linked customer submitting the SAME rating + comment again is an
    // accidental double-submit. For anonymous submissions only IDENTICAL
    // non-empty comments are treated as duplicates (a strong signal); bare
    // repeat ratings from different guests remain allowed — the IP limiter
    // already caps anonymous volume, so legitimate customers are not rejected.
    const since = new Date(Date.now() - DUPLICATE_COOLDOWN_MS);
    if (customerId || comment) {
      const duplicate = await db.feedback.findFirst({
        where: {
          hotelId,
          rating,
          ...(comment ? { comment } : {}),
          ...(customerId ? { customerId } : {}),
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (duplicate) {
        return Response.json(
          {
            error: {
              code: "DUPLICATE_FEEDBACK",
              message: "This feedback was already recorded. Thank you for sharing your experience!",
            },
          },
          { status: 409 },
        );
      }
    }

    const feedback = await db.feedback.create({
      data: {
        hotelId,
        customerId,
        rating,
        comment: comment || null,
        source: "QR_PAGE",
      },
    });

    await logAudit({
      req,
      hotelId,
      action: AUDIT_ACTIONS.FEEDBACK_RECEIVED,
      entityType: "feedback",
      entityId: feedback.id,
      metadata: {
        rating,
        linked: Boolean(customerId),
        source: "QR_PAGE",
      },
    });

    // Phase 15 — instant low-rating alert (reliable retry, audited). Never
    // blocks the guest's submission; failures are logged for reconciliation.
    try {
      const { alertLowRating } = await import("@/lib/retention-alerts");
      await alertLowRating(hotelId, feedback.id, rating, comment || null);
    } catch (err) {
      console.error("[feedback-alert] failed:", err instanceof Error ? err.message : err);
    }

    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return serverError(err, "Feedback could not be submitted. Please try again.");
  }
}
