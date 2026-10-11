import { db } from "@/lib/db";
import { requireAuth, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";

/**
 * Phase 14 — POS day summary (MVP report #6).
 * GET /api/reports/sales?date=YYYY-MM-DD&tz=Asia/Kolkata
 *
 * Business-day semantics: the day boundary is computed in the TENANT's IANA
 * timezone (Hotel.timezone), stored UTC. All figures reconcile against
 * invoices/payment allocations/refunds — not against clicks or taps.
 */
function localDayBounds(dateStr: string, tz: string): { start: Date; end: Date } {
  // Compute the UTC instants of [local midnight, next local midnight) using
  // Intl to stay correct across DST without external libraries.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const guessOffset = (at: Date): number => {
    const parts = fmt.formatToParts(at);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    const asUTC = Date.UTC(y, m - 1, d);
    return asUTC - Math.floor(at.getTime() / 1000) * 1000;
  };
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const offset = guessOffset(new Date(utcGuess));
  const startMs = Date.UTC(y, m - 1, d) - offset;
  const endOffset = guessOffset(new Date(startMs + 24 * 3600_000 - 60_000));
  const start = new Date(startMs);
  const end = new Date(startMs + 24 * 3600_000 - endOffset + (endOffset === offset ? 0 : 0));
  return { start, end };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId }, select: { timezone: true } });
    const tz = url.searchParams.get("tz") || hotel?.timezone || "Asia/Kolkata";
    // Default: today in the tenant timezone.
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const dateStr = url.searchParams.get("date") || todayLocal;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 422 });
    }
    const { start, end } = localDayBounds(dateStr, tz);

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
