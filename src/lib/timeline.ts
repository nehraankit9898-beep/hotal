import { db } from "@/lib/db";

/**
 * Customer Timeline — Phase 3
 *
 * Builds a unified, reverse-chronological timeline per customer from
 * multiple event sources: visits, campaign messages, coupon redemptions,
 * consent changes, segment membership, manual admin notes.
 */

export interface TimelineEntry {
  type: string;
  label: string;
  timestamp: string;
  detail?: string;
  amount?: number;
  user?: string | null;
}

export async function buildCustomerTimeline(
  customerId: string,
  hotelId: string,
  limit = 50,
): Promise<TimelineEntry[]> {
  // Verify tenant ownership
  const customer = await db.customer.findFirst({
    where: { id: customerId, hotelId },
    select: { id: true, createdAt: true, name: true, marketingConsent: true, optOut: true },
  });
  if (!customer) return [];

  const events: TimelineEntry[] = [];

  // Customer created
  events.push({
    type: "CUSTOMER_CREATED",
    label: "Customer record created",
    timestamp: customer.createdAt.toISOString(),
  });

  if (customer.marketingConsent) {
    events.push({
      type: "CONSENT_GRANTED",
      label: "Marketing consent granted",
      timestamp: customer.createdAt.toISOString(), // approximated at creation
    });
  }
  if (customer.optOut) {
    events.push({
      type: "CONSENT_REVOKED",
      label: "Customer opted out of marketing",
      timestamp: customer.createdAt.toISOString(),
    });
  }

  // Visits (bookings + checkouts)
  const visits = await db.visit.findMany({
    where: { customerId },
    select: { checkin: true, checkout: true, source: true, amount: true, notes: true },
    orderBy: { checkin: "asc" },
  });
  for (const v of visits) {
    events.push({
      type: "BOOKING",
      label: "Stay booked",
      timestamp: v.checkin.toISOString(),
      amount: v.amount ?? undefined,
      detail: v.notes ?? `Source: ${v.source}`,
    });
    if (v.checkout) {
      events.push({
        type: "CHECKOUT",
        label: "Checked out",
        timestamp: v.checkout.toISOString(),
        detail: v.notes ?? undefined,
      });
    }
  }

  // Campaign messages
  const messages = await db.campaignMessage.findMany({
    where: { customerId },
    select: {
      status: true,
      channel: true,
      sentAt: true,
      openedAt: true,
      clickedAt: true,
      bookingAmount: true,
    },
    orderBy: { createdAt: "desc" },
  });
  for (const m of messages) {
    if (m.sentAt) {
      events.push({
        type: "CAMPAIGN_SENT",
        label: `Campaign message sent (${m.channel})`,
        timestamp: m.sentAt.toISOString(),
        detail: m.status,
      });
    }
    if (m.openedAt) {
      events.push({
        type: "CAMPAIGN_OPENED",
        label: `Message opened (${m.channel})`,
        timestamp: m.openedAt.toISOString(),
      });
    }
    if (m.clickedAt) {
      events.push({
        type: "CAMPAIGN_CLICKED",
        label: `Link clicked (${m.channel})`,
        timestamp: m.clickedAt.toISOString(),
      });
    }
    if (m.bookingAmount) {
      events.push({
        type: "PAYMENT",
        label: "Booking attributed",
        timestamp:
          m.clickedAt?.toISOString() ?? m.sentAt?.toISOString() ?? new Date().toISOString(),
        amount: m.bookingAmount,
      });
    }
  }

  // Coupon redemptions
  const redemptions = await db.couponRedemption.findMany({
    where: { customerId },
    select: {
      coupon: { select: { code: true } },
      redeemedAt: true,
      discountAmount: true,
      orderAmount: true,
    },
    orderBy: { redeemedAt: "desc" },
  });
  for (const r of redemptions) {
    events.push({
      type: "COUPON_REDEEMED",
      label: `Coupon ${r.coupon.code} redeemed`,
      timestamp: r.redeemedAt.toISOString(),
      amount: r.discountAmount,
      detail: `Order: ₹${(r.orderAmount ?? 0).toFixed(2)}`,
    });
  }

  // Restaurant visits
  const restaurantVisits = await db.restaurantVisit.findMany({
    where: { customerId },
    select: { visitDate: true, orderAmount: true, source: true, tableNumber: true, guests: true },
    orderBy: { visitDate: "desc" },
  });
  for (const rv of restaurantVisits) {
    events.push({
      type: "RESTAURANT_VISIT",
      label: "Restaurant visit",
      timestamp: rv.visitDate.toISOString(),
      amount: rv.orderAmount,
      detail: `Table ${rv.tableNumber ?? "—"} · ${rv.guests} guests · ${rv.source}`,
    });
  }

  // Timeline events table (manual notes / system events)
  const timelineEvents = await db.timelineEvent.findMany({
    where: { customerId },
    select: { type: true, label: true, detail: true, amount: true, createdAt: true, userId: true },
    orderBy: { createdAt: "desc" },
  });
  for (const e of timelineEvents) {
    events.push({
      type: e.type,
      label: e.label,
      timestamp: e.createdAt.toISOString(),
      detail: e.detail ?? undefined,
      amount: e.amount ?? undefined,
    });
  }

  // Sort by timestamp DESC, then take the latest N
  return events
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

/** Add a manual timeline entry (admin note, etc). */
export async function addTimelineEvent(params: {
  hotelId: string;
  customerId: string;
  type: string;
  label: string;
  detail?: string;
  amount?: number;
  userId?: string | null;
}) {
  return db.timelineEvent.create({
    data: {
      hotelId: params.hotelId,
      customerId: params.customerId,
      type: params.type as never,
      label: params.label,
      detail: params.detail ?? null,
      amount: params.amount ?? null,
      userId: params.userId ?? null,
    },
  });
}
