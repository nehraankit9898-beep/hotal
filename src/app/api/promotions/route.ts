import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

/**
 * Phase 15 — promotions (percent/flat/happy-hour/combo).
 *
 * GET  /api/promotions — list (PROMOTION_MANAGE or BILL_READ for POS)
 * POST /api/promotions — create { name, type, percentBps?|valueMinor?,
 *   itemIdsJson?/categoryIdsJson?, daysOfWeek?, startTime?, endTime?,
 *   startDate?, endDate?, priority?, stackable? }
 *
 * Server-side application only: bills freeze (promotionId, version, label).
 * Editing a promotion bumps `version` — issued invoices are NEVER rewritten.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const promos = await db.promotion.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    });
    return Response.json({ promotions: promos });
  } catch (err) {
    return serverError(err);
  }
}

const PROMO_TYPES = ["PERCENT", "FLAT", "HAPPY_HOUR", "COMBO"];
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PROMOTION_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3) return jsonError("Promotion name is required (min 3 chars).", 422, "INVALID_NAME");
    const type = body.type;
    if (typeof type !== "string" || !PROMO_TYPES.includes(type)) {
      return jsonError(`type must be one of ${PROMO_TYPES.join(", ")}.`, 422, "INVALID_TYPE");
    }
    let percentBps: number | null = null;
    let valueMinor: number | null = null;
    if (type === "PERCENT" || type === "HAPPY_HOUR") {
      percentBps = Number(body.percentBps);
      if (!Number.isFinite(percentBps) || Math.floor(percentBps) !== percentBps || percentBps <= 0 || percentBps > 10_000) {
        return jsonError("percentBps must be 1..10000 (0.01%..100%).", 422, "INVALID_VALUE");
      }
    } else {
      valueMinor = Number(body.valueMinor);
      if (!Number.isFinite(valueMinor) || Math.floor(valueMinor) !== valueMinor || valueMinor <= 0) {
        return jsonError("valueMinor must be a positive integer (minor units).", 422, "INVALID_VALUE");
      }
    }
    let daysOfWeek: string | null = null;
    if (Array.isArray(body.daysOfWeek)) {
      const days = (body.daysOfWeek as unknown[]).filter((d): d is string => typeof d === "string" && DAYS.includes(d));
      if (days.length > 0) daysOfWeek = JSON.stringify([...new Set(days)]);
    }
    let startTime: string | null = null;
    let endTime: string | null = null;
    if (type === "HAPPY_HOUR") {
      if (typeof body.startTime !== "string" || !TIME_RE.test(body.startTime) || typeof body.endTime !== "string" || !TIME_RE.test(body.endTime)) {
        return jsonError("Happy-hour promotions need startTime/endTime as HH:MM (hotel-local).", 422, "INVALID_WINDOW");
      }
      startTime = body.startTime;
      endTime = body.endTime;
    }
    const parseDate = (v: unknown): Date | null => {
      if (typeof v !== "string" || !v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const startDate = parseDate(body.startDate);
    const endDate = parseDate(body.endDate);
    if (startDate && endDate && endDate < startDate) {
      return jsonError("endDate must be after startDate.", 422, "INVALID_WINDOW");
    }

    const promo = await db.promotion.create({
      data: {
        hotelId: auth.user.hotelId!,
        name,
        type,
        percentBps,
        valueMinor,
        itemIdsJson: Array.isArray(body.itemIds) && body.itemIds.length > 0 ? JSON.stringify(body.itemIds) : null,
        categoryIdsJson: Array.isArray(body.categoryIds) && body.categoryIds.length > 0 ? JSON.stringify(body.categoryIds) : null,
        daysOfWeek,
        startTime,
        endTime,
        startDate,
        endDate,
        priority: typeof body.priority === "number" ? Math.floor(body.priority) : 0,
        stackable: body.stackable === true,
        createdByUserId: auth.user.userId,
      },
    });
    await logAudit({
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: "PROMOTION_CREATED",
      entityType: "Promotion",
      entityId: promo.id,
      metadata: { name, type },
      req,
    });
    return Response.json({ promotion: promo }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
