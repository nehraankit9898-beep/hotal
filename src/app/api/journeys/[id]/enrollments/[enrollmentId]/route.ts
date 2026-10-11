import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

type Ctx = { params: Promise<{ id: string; enrollmentId: string }> };

const VALID_ACTIONS = ["PAUSED", "ACTIVE", "CANCELLED"] as const;
type EnrollmentAction = (typeof VALID_ACTIONS)[number];

/**
 * PATCH /api/journeys/[id]/enrollments/[enrollmentId] — enrollment lifecycle
 * control (medium fix item 7): the JourneyEnrollmentStatus enum has always
 * carried PAUSED/CANCELLED states, but NO API could set them — an enrolled
 * customer could never be paused, resumed or removed from a journey.
 *
 * Body: { status: "PAUSED" | "ACTIVE" | "CANCELLED" }
 *  - PAUSED: delivery sweeps skip the enrollment until resumed.
 *  - ACTIVE: resumes a paused enrollment (the due step runs on the next sweep).
 *  - CANCELLED: terminal — the enrollment never processes again.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CAMPAIGN_UPDATE");
    if (denied) return denied;
    const { id, enrollmentId } = await ctx.params;

    const journey = await db.journey.findFirst({
      where: { id, hotelId: auth.user.hotelId },
      select: { id: true },
    });
    if (!journey) return jsonError("Journey not found.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const status = body.status as EnrollmentAction;
    if (!VALID_ACTIONS.includes(status)) {
      return jsonError(`status must be one of: ${VALID_ACTIONS.join(", ")}.`);
    }

    const enrollment = await db.journeyEnrollment.findFirst({
      where: { id: enrollmentId, journeyId: id, hotelId: auth.user.hotelId },
      select: { id: true, status: true },
    });
    if (!enrollment) return jsonError("Enrollment not found.", 404, "NOT_FOUND");

    if (enrollment.status === "COMPLETED") {
      return jsonError("This enrollment already completed the journey.", 409, "TERMINAL");
    }
    if (enrollment.status === "CANCELLED") {
      return jsonError("This enrollment is cancelled and cannot be changed.", 409, "TERMINAL");
    }

    const updated = await db.journeyEnrollment.updateMany({
      where: { id: enrollment.id, status: enrollment.status }, // fenced
      data: {
        status,
        ...(status === "CANCELLED" ? { completedAt: new Date(), nextStepAt: null } : {}),
      },
    });
    if (updated.count !== 1) {
      return jsonError("Enrollment was just changed by someone else. Refresh and retry.", 409, "VERSION_CONFLICT");
    }

    return Response.json({ ok: true, status });
  } catch (err) {
    return serverError(err, "The enrollment could not be updated.");
  }
}
