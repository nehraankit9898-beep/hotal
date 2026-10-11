import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { computeForecasts } from "@/lib/ai/forecasting";

/**
 * Phase 18 — demand forecasts (ADVISORY ONLY).
 *
 * GET  /api/ai/forecast?date=YYYY-MM-DD — view stored forecasts (AI_READ).
 *      Rows with sufficient=false come back flagged NOT_ENOUGH_DATA — the UI
 *      must show them as unavailable, never as a number.
 * POST /api/ai/forecast — recompute (AI_MANAGE). Never mutates stock/purchasing.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const date = url.searchParams.get("date");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonError("date must be YYYY-MM-DD.", 422, "INVALID_DATE");
    }

    const forecasts = await db.demandForecast.findMany({
      where: { hotelId: auth.user.hotelId, ...(date ? { businessDate: date } : {}) },
      orderBy: [{ businessDate: "asc" }, { menuItemId: "asc" }],
      include: { menuItem: { select: { name: true } } },
      take: 1000,
    });

    return Response.json({
      advisoryOnly: true,
      forecasts: forecasts.map((f) => ({
        id: f.id,
        menuItemId: f.menuItemId,
        menuItemName: f.menuItem?.name ?? null,
        businessDate: f.businessDate,
        dow: f.dow,
        // When sufficient=false the numbers ARE NOT a forecast — explicit nulls.
        forecastQty: f.sufficient ? f.forecastQty : null,
        lowerBound: f.sufficient ? f.lowerBound : null,
        upperBound: f.sufficient ? f.upperBound : null,
        dataStatus: f.sufficient ? "OK" : "NOT_ENOUGH_DATA",
        method: f.method,
        dataPoints: f.dataPoints,
        mae: f.mae,
        naiveMae: f.naiveMae,
        skill: f.mae !== null && f.naiveMae ? Number((1 - f.mae / f.naiveMae).toFixed(3)) : null,
        computedAt: f.computedAt,
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AI_MANAGE");
    if (denied) return denied;

    const body = (await readJson(req)) ?? {};
    const result = await computeForecasts(auth.user.hotelId, {
      horizonDays: Number(body.horizonDays ?? 7) || 7,
    });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return serverError(err);
  }
}
