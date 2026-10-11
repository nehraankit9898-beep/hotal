import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { createCustomerWithinLimit } from "@/lib/saas/limits";

/**
 * GET /api/customers — server-side search / filter / sort / pagination.
 * Query: q, consent (all|opted_in|opted_out), status (all|active|inactive),
 *        sort (created|name|visits|last_visit), order (asc|desc), page, pageSize
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const consent = url.searchParams.get("consent") || "all";
    const status = url.searchParams.get("status") || "all";
    const sort = url.searchParams.get("sort") || "created";
    const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      50,
      Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10),
    );

    const where: Record<string, unknown> = { hotelId };
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q.replace(/[\s\-()+]/g, "") } },
        { email: { contains: q } },
      ];
    }
    if (consent === "opted_in") where.AND = [{ marketingConsent: true }, { optOut: false }];
    else if (consent === "opted_out") where.optOut = true;
    if (status === "active") where.status = "ACTIVE";
    else if (status === "inactive") where.status = "INACTIVE";

    const include = {
      _count: { select: { visits: true, restaurantVisits: true } },
      visits: { orderBy: { checkin: "desc" as const }, take: 1, select: { checkin: true } },
    };

    // Phase 2: spend aggregation for the current filter (all matching rows)
    // AUDIT FIX (F10): restaurant visits count toward customer value. The old
    // aggregates ONLY read hotel `Visit` rows — a customer with two café bills
    // showed totalVisits=0 / totalSpend=0 in the CRM list. Hotel-stay and
    // restaurant metrics are kept BOTH separate (…Restaurant…) AND unified
    // (totalVisits/lastVisit/totalSpend) so café workspaces see real numbers
    // while hotel workspaces are unaffected.
    const spendRows = await db.customer.findMany({
      where,
      select: {
        id: true,
        visits: { select: { amount: true } },
        restaurantVisits: { select: { orderAmount: true } },
      },
    });
    const spendMap = new Map<string, number>(
      spendRows.map((r) => [
        r.id,
        Math.round(
          (r.visits.reduce((s, v) => s + (v.amount ?? 0), 0) +
            r.restaurantVisits.reduce((s, v) => s + v.orderAmount, 0)) *
            100,
        ) / 100,
      ]),
    );

    const total = await db.customer.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const skip = (page - 1) * pageSize;

    let rows;
    // For aggregate sorts, the accurate last-visit (incl. restaurant) per id.
    let lastVisitMap: Map<string, Date | null> | null = null;

    if (sort === "visits" || sort === "last_visit") {
      // Aggregate sort: compute per-customer stats, sort, then fetch the page rows
      const stats = await db.customer.findMany({
        where,
        select: {
          id: true,
          _count: { select: { visits: true, restaurantVisits: true } },
          visits: { orderBy: { checkin: "desc" as const }, take: 1, select: { checkin: true } },
          restaurantVisits: {
            orderBy: { visitDate: "desc" as const },
            take: 1,
            select: { visitDate: true },
          },
        },
      });
      stats.sort((a, b) => {
        if (sort === "visits") {
          const av = a._count.visits + a._count.restaurantVisits;
          const bv = b._count.visits + b._count.restaurantVisits;
          return order === "asc" ? av - bv : bv - av;
        }
        const aStay = a.visits[0]?.checkin?.getTime() ?? 0;
        const aDine = a.restaurantVisits[0]?.visitDate?.getTime() ?? 0;
        const bStay = b.visits[0]?.checkin?.getTime() ?? 0;
        const bDine = b.restaurantVisits[0]?.visitDate?.getTime() ?? 0;
        const av = Math.max(aStay, aDine);
        const bv = Math.max(bStay, bDine);
        return order === "asc" ? av - bv : bv - av;
      });
      const pageIds = stats.slice(skip, skip + pageSize).map((s) => s.id);
      const fetched = await db.customer.findMany({ where: { id: { in: pageIds } }, include });
      const orderMap = new Map(pageIds.map((id, i) => [id, i]));
      fetched.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
      rows = fetched;
      // Preserve the aggregate sort's last-visit semantics (restaurant included)
      lastVisitMap = new Map(
        stats.map((s) => {
          const stay = s.visits[0]?.checkin ?? null;
          const dine = s.restaurantVisits[0]?.visitDate ?? null;
          const last = stay && dine ? (stay > dine ? stay : dine) : (stay ?? dine);
          return [s.id, last];
        }),
      );
    } else {
      const orderBy =
        sort === "name"
          ? { name: order as "asc" | "desc" }
          : order === "asc"
            ? { createdAt: "asc" as const }
            : { createdAt: "desc" as const };
      rows = await db.customer.findMany({ where, orderBy, skip, take: pageSize, include });
    }

    return Response.json({
      customers: rows.map((c) => {
        // AUDIT FIX (F10): unified + separated customer metrics. A café
        // customer's visits/spend now INCLUDE restaurant activity; the
        // hotel-only view stays available under the …Restaurant-suffixed
        // fields for mixed hotel+café businesses.
        const stayCount = c._count.visits;
        const dineCount = c._count.restaurantVisits;
        const lastStay = c.visits[0]?.checkin ?? null;
        const lastDine = c.lastRestaurantVisit ?? null;
        const lastAny = lastVisitMap
          ? (lastVisitMap.get(c.id) ?? null)
          : lastStay && lastDine
            ? lastStay > lastDine
              ? lastStay
              : lastDine
            : (lastStay ?? lastDine);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          marketingConsent: c.marketingConsent,
          whatsappOptIn: c.whatsappOptIn,
          smsOptIn: c.smsOptIn,
          emailOptIn: c.emailOptIn,
          optOut: c.optOut,
          consentTimestamp: c.consentTimestamp,
          status: c.status,
          createdAt: c.createdAt,
          // Unified (hotel stays + restaurant bills):
          totalVisits: stayCount + dineCount,
          lastVisit: lastAny,
          campaignEligible: c.marketingConsent && !c.optOut && c.status === "ACTIVE",
          vip: c.vip,
          totalSpend: spendMap.get(c.id) ?? 0,
          // Domain-separated views (hotel stays only / restaurant only):
          hotelVisits: stayCount,
          lastHotelVisit: lastStay,
          restaurantVisits: dineCount,
          lastRestaurantVisit: lastDine,
          totalRestaurantSpend: c.totalRestaurantSpend,
        };
      }),
      total,
      page,
      pageSize,
      totalPages,
    });
  } catch (err) {
    return serverError(err, "Could not load customers right now. Please refresh the page.");
  }
}

/** POST /api/customers — create a customer (phone normalized + duplicate check). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // RECHECK FIX (I): the plan limit is enforced ATOMICALLY with the create
    // (a pre-check was not enforcement — concurrent creates bypassed it).
    // The capacity check happens inside the create transaction; a full
    // member list returns the same 403 SUBSCRIPTION_LIMIT_REACHED contract.

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const marketingConsent = body.marketingConsent === true;
    const consentSource =
      typeof body.consentSource === "string" && body.consentSource
        ? body.consentSource
        : "MANUAL_ENTRY";
    // Phase 6.4 — channel-level opt-ins: only meaningful WITH marketing consent.
    const channelOptIns = {
      whatsapp: marketingConsent && body.whatsappOptIn === true,
      sms: marketingConsent && body.smsOptIn === true,
      email: marketingConsent && body.emailOptIn === true,
    };

    if (name.length < 2) return jsonError("Please enter the customer's full name.");
    if (name.length > 100) return jsonError("Customer name is too long.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonError("Please enter a valid email address.");
    }

    const phoneResult = normalizePhone(phone);
    if (!phoneResult.ok)
      return jsonError(phoneResult.error || "Please enter a valid phone number.");

    const duplicate = await db.customer.findFirst({
      where: { hotelId, phone: phoneResult.normalized! },
    });
    if (duplicate) {
      return jsonError(
        "A customer with this phone number already exists. Please check the existing customer list.",
        409,
        "DUPLICATE_PHONE",
      );
    }

    const result = await createCustomerWithinLimit(hotelId, (tx) =>
      tx.customer.create({
        data: {
          hotelId,
          name,
          phone: phoneResult.normalized!,
          email: email || null,
          marketingConsent,
          consentTimestamp: marketingConsent ? new Date() : null,
          consentSource: marketingConsent ? consentSource : null,
          optOut: false,
          whatsappOptIn: channelOptIns.whatsapp,
          smsOptIn: channelOptIns.sms,
          emailOptIn: channelOptIns.email,
          // Phase 2 intelligence fields (all optional)
          roomPreference:
            typeof body.roomPreference === "string" && body.roomPreference.trim()
              ? body.roomPreference.trim().slice(0, 60)
              : null,
          foodPreference:
            typeof body.foodPreference === "string" && body.foodPreference.trim()
              ? body.foodPreference.trim().slice(0, 60)
              : null,
          location:
            typeof body.location === "string" && body.location.trim()
              ? body.location.trim().slice(0, 80)
              : null,
          birthday: parseDateOrNull(body.birthday),
          anniversary: parseDateOrNull(body.anniversary),
          source:
            typeof body.source === "string" &&
            ["WALK_IN", "BOOKING", "WEBSITE", "REFERRAL", "OTHER"].includes(body.source)
              ? body.source
              : null,
          notes:
            typeof body.notes === "string" && body.notes.trim()
              ? body.notes.trim().slice(0, 1000)
              : null,
          vip: body.vip === true,
        },
      }),
    );
    if (!result.ok) {
      return jsonError(result.failure.message, 403, result.failure.code);
    }
    const customer = result.value;

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      entityType: "customer",
      entityId: customer.id,
      metadata: { name, phone: customer.phone, consent: marketingConsent },
    });

    return Response.json({ customer }, { status: 201 });
  } catch (err) {
    return serverError(err, "Customer could not be saved. Please check the details and try again.");
  }
}

function parseDateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
