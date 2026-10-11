import { db } from "@/lib/db";
import {
  requireAuth,
  jsonError,
  readJson,
  serverError,
  getTenantCustomer,
} from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { normalizePhone } from "@/lib/phone";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/customers/[id] — full profile: info, visit stats, visits, activity timeline. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;
    const { id } = await ctx.params;

    // Multi-tenant isolation: scoped lookup — foreign IDs return 404
    const customer = await getTenantCustomer(id, auth.user.hotelId);
    if (!customer) {
      return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");
    }

    const visits = await db.visit.findMany({
      where: { customerId: id, hotelId: auth.user.hotelId },
      orderBy: { checkin: "desc" },
    });

    const totalVisits = visits.length;
    const totalSpend = visits.reduce((s, v) => s + (v.amount ?? 0), 0);
    const firstVisit = totalVisits ? visits[visits.length - 1].checkin : null;
    const lastVisit = totalVisits ? visits[0].checkin : null;

    // Activity timeline: created → consent → visits (chronological) → opt-out → campaigns
    const timeline: {
      type: string;
      label: string;
      timestamp: Date;
      detail?: string;
      amount?: number;
    }[] = [{ type: "customer_created", label: "Customer added", timestamp: customer.createdAt }];
    if (customer.consentTimestamp && customer.marketingConsent) {
      timeline.push({
        type: "consent_granted",
        label: "Marketing consent given",
        timestamp: customer.consentTimestamp,
        detail: customer.consentSource || undefined,
      });
    }
    for (const v of [...visits].reverse()) {
      timeline.push({
        type: "visit",
        label: `Visit recorded`,
        timestamp: v.checkin,
        detail: v.source === "CSV_IMPORT" ? "Imported from CSV" : "Added manually",
        amount: v.amount ?? undefined,
      });
    }
    if (customer.optOut && customer.consentTimestamp) {
      timeline.push({
        type: "opt_out",
        label: "Marketing opt-out",
        timestamp: customer.updatedAt,
      });
    }

    // Phase 2: campaign messages appear on the timeline
    const campaignMessages = await db.campaignMessage.findMany({
      where: { customerId: id, hotelId: auth.user.hotelId, status: { in: ["SENT", "SIMULATED"] } },
      include: { campaign: { select: { name: true } } },
      orderBy: { sentAt: "desc" },
      take: 50,
    });
    for (const m of campaignMessages) {
      if (!m.sentAt) continue;
      timeline.push({
        type: "campaign_message",
        label: m.campaign.name,
        timestamp: m.sentAt,
        detail: `Message sent via ${m.channel.toLowerCase()}${m.bookingLinked ? " · booking received" : ""}`,
        amount: m.bookingAmount ?? undefined,
      });
    }
    timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Phase 2: segment memberships
    const segmentMemberships = await db.segmentMember.findMany({
      where: { customerId: id },
      include: { segment: { select: { id: true, name: true, type: true, color: true } } },
    });

    return Response.json({
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        marketingConsent: customer.marketingConsent,
        whatsappOptIn: customer.whatsappOptIn,
        smsOptIn: customer.smsOptIn,
        emailOptIn: customer.emailOptIn,
        consentTimestamp: customer.consentTimestamp,
        consentSource: customer.consentSource,
        optOut: customer.optOut,
        status: customer.status,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,
        campaignEligible:
          customer.marketingConsent && !customer.optOut && customer.status === "ACTIVE",
        // Phase 2 fields
        roomPreference: customer.roomPreference,
        foodPreference: customer.foodPreference,
        location: customer.location,
        birthday: customer.birthday,
        anniversary: customer.anniversary,
        source: customer.source,
        notes: customer.notes,
        vip: customer.vip,
        totalSpend,
      },
      stats: { totalVisits, firstVisit, lastVisit, totalSpend },
      visits: visits.map((v) => ({
        id: v.id,
        checkin: v.checkin,
        checkout: v.checkout,
        source: v.source,
        notes: v.notes,
        amount: v.amount,
        createdAt: v.createdAt,
      })),
      segments: segmentMemberships.map((s) => ({
        id: s.segment.id,
        name: s.segment.name,
        type: s.segment.type,
        color: s.segment.color,
      })),
      timeline,
    });
  } catch (err) {
    return serverError(err, "Could not load this customer's profile. Please try again.");
  }
}

/** PATCH /api/customers/[id] — update basic info. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const customer = await getTenantCustomer(id, hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2) return jsonError("Please enter the customer's full name.");
      data.name = name;
    }

    if (body.phone !== undefined) {
      const phoneResult = normalizePhone(String(body.phone));
      if (!phoneResult.ok)
        return jsonError(phoneResult.error || "Please enter a valid phone number.");
      if (phoneResult.normalized !== customer.phone) {
        const duplicate = await db.customer.findFirst({
          where: { hotelId, phone: phoneResult.normalized!, NOT: { id: customer.id } },
        });
        if (duplicate) {
          return jsonError(
            "Another customer with this phone number already exists.",
            409,
            "DUPLICATE_PHONE",
          );
        }
        data.phone = phoneResult.normalized!;
      }
    }

    if (body.email !== undefined) {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonError("Please enter a valid email address.");
      }
      data.email = email || null;
    }

    if (body.status !== undefined) {
      if (body.status !== "ACTIVE" && body.status !== "INACTIVE") {
        return jsonError("Invalid status value.");
      }
      data.status = body.status;
    }

    // ---- Phase 6.4: channel-level consent opt-ins ----
    // An opt-in is meaningful only together with marketing consent: ticking a
    // channel while marketingConsent is (or becomes) false stores false. An
    // explicit false REVOKES that channel only (the other channels are left
    // untouched — per-channel granularity, never a silent all-or-nothing).
    for (const [field, key] of [
      ["whatsappOptIn", "whatsappOptIn"],
      ["smsOptIn", "smsOptIn"],
      ["emailOptIn", "emailOptIn"],
    ] as const) {
      if (body[key] !== undefined) {
        const next =
          body[key] === true && (body.marketingConsent === true || customer.marketingConsent);
        data[field] = next;
        if (next) data.consentTimestamp = new Date();
      }
    }
    // Revoking marketing consent as a whole clears every channel opt-in.
    if (body.marketingConsent === false) {
      data.marketingConsent = false;
      data.whatsappOptIn = false;
      data.smsOptIn = false;
      data.emailOptIn = false;
    }
    // Granting marketing consent (upgrade) stamps the consent timestamp.
    if (body.marketingConsent === true && !customer.marketingConsent) {
      data.marketingConsent = true;
      data.consentTimestamp = new Date();
      data.consentSource = "MANUAL_ENTRY";
    }

    // ---- Phase 2: customer intelligence fields ----
    if (body.roomPreference !== undefined) {
      data.roomPreference =
        typeof body.roomPreference === "string"
          ? body.roomPreference.trim().slice(0, 60) || null
          : null;
    }
    if (body.foodPreference !== undefined) {
      data.foodPreference =
        typeof body.foodPreference === "string"
          ? body.foodPreference.trim().slice(0, 60) || null
          : null;
    }
    if (body.location !== undefined) {
      data.location =
        typeof body.location === "string" ? body.location.trim().slice(0, 80) || null : null;
    }
    if (body.notes !== undefined) {
      data.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) || null : null;
    }
    if (body.vip !== undefined) {
      data.vip = Boolean(body.vip);
    }
    if (body.source !== undefined) {
      const allowed = ["WALK_IN", "BOOKING", "WEBSITE", "REFERRAL", "OTHER"];
      if (body.source !== null && !allowed.includes(String(body.source))) {
        return jsonError("Invalid customer source value.");
      }
      data.source = body.source === null || body.source === "" ? null : String(body.source);
    }
    for (const field of ["birthday", "anniversary"] as const) {
      if (body[field] !== undefined) {
        if (body[field] === null || body[field] === "") {
          data[field] = null;
        } else {
          const d = new Date(String(body[field]));
          if (isNaN(d.getTime())) {
            return jsonError(
              field === "birthday"
                ? "The birthday date is not valid."
                : "The anniversary date is not valid.",
            );
          }
          data[field] = d;
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return jsonError("Nothing to update.");
    }

    const updated = await db.customer.update({ where: { id: customer.id }, data });

    await logAudit({
      req,
      hotelId,
      userId,
      action:
        body.status === "INACTIVE"
          ? AUDIT_ACTIONS.CUSTOMER_DEACTIVATED
          : AUDIT_ACTIONS.CUSTOMER_UPDATED,
      entityType: "customer",
      entityId: customer.id,
      metadata: { fields: Object.keys(data) },
    });

    return Response.json({ customer: updated });
  } catch (err) {
    return serverError(
      err,
      "Customer could not be updated. Please check the details and try again.",
    );
  }
}

/** DELETE /api/customers/[id] — soft delete (deactivate). */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_DELETE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const customer = await getTenantCustomer(id, hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    await db.customer.update({
      where: { id: customer.id },
      data: { status: "INACTIVE" },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CUSTOMER_DEACTIVATED,
      entityType: "customer",
      entityId: customer.id,
      metadata: { name: customer.name },
    });

    return Response.json({ ok: true, message: "Customer deactivated." });
  } catch (err) {
    return serverError(err, "Customer could not be deactivated. Please try again.");
  }
}
