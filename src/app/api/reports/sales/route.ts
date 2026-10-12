import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { isValidTimeZone, zonedDayBounds } from "@/lib/timezone";

/**
 * Phase 14 — POS day summary (MVP report #6).
 * GET /api/reports/sales?date=YYYY-MM-DD&tz=Asia/Kolkata
 *
 * Business-day semantics: the day boundary is computed in the TENANT's IANA
 * timezone (Hotel.timezone), stored UTC. All figures reconcile against
 * invoices/payment allocations/refunds — not against clicks or taps.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId }, select: { timezone: true } });
    const tz = url.searchParams.get("tz") || hotel?.timezone || "Asia/Kolkata";
    if (!isValidTimeZone(tz)) {
      return Response.json({ error: "tz must be a valid IANA timezone" }, { status: 422 });
    }
    // Default: today in the tenant timezone.
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const dateStr = url.searchParams.get("date") || todayLocal;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 422 });
    }
    const { start, end } = zonedDayBounds(dateStr, tz);

    const [bills, payments, refunds] = await Promise.all([
      db.bill.findMany({
        where: { hotelId: auth.user.hotelId, issuedAt: { gte: start, lt: end }, status: { not: "VOID" } },
        select: { subtotalMinor: true, discountMinor: true, taxMinor: true, totalMinor: true, status: true, series: true, billNumber: true, issuedAt: true },
      }),
      db.billPayment.findMany({
        where: { hotelId: auth.user.hotelId, paidAt: { gte: start, lt: end }, status: { in: ["RECORDED", "CAPTURED"] } },
        select: { method: true, amountMinor: true, source: true },
      }),
      db.billRefund.findMany({
        where: { hotelId: auth.user.hotelId, createdAt: { gte: start, lt: end }, type: "REFUND" },
        select: { amountMinor: true },
      }),
    ]);

    const netSalesMinor = bills.reduce((s, b) => s + b.subtotalMinor - b.discountMinor, 0);
    const grossMinor = bills.reduce((s, b) => s + b.subtotalMinor, 0);
    const discountMinor = bills.reduce((s, b) => s + b.discountMinor, 0);
    const taxMinor = bills.reduce((s, b) => s + b.taxMinor, 0);
    const refundMinor = refunds.reduce((s, r) => s + r.amountMinor, 0);

    const byMethod: Record<string, number> = {};
    for (const p of payments) {
      byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountMinor;
    }
    const bySource = {
      gatewayVerified: payments.filter((p) => p.source === "GATEWAY").length,
      manuallyRecorded: payments.filter((p) => p.source === "MANUAL").length,
    };

    return Response.json({
      date: dateStr,
      timezone: tz,
      window: { startUtc: start.toISOString(), endUtc: end.toISOString() },
      bills: { count: bills.length, grossMinor, discountMinor, netSalesMinor, taxMinor, refundMinor },
      payments: { byMethod, bySource },
    });
  } catch (err) {
    return serverError(err);
  }
}
