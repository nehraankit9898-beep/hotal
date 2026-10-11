/**
 * Phase 15 — instant low-rating feedback alert.
 *
 * Policy: when a feedback rating is <= the tenant-configured threshold
 * (HotelSettings.feedbackAlertThreshold, default 3), the owner's hotel email
 * receives an alert. Delivery uses the shared retry transport; each feedback
 * id alerts at most once (TimelineEvent marker is the fence). This is a
 * transactional operations alert — it does NOT require marketing consent and
 * never contacts the guest.
 */

import { db } from "@/lib/db";
import { sendEmailWithRetry } from "@/lib/providers/email";

export async function alertLowRating(hotelId: string, feedbackId: string, rating: number, comment: string | null): Promise<void> {
  const settings = await db.hotelSettings.findUnique({ where: { hotelId } });
  const threshold = settings?.feedbackAlertThreshold ?? 3;
  if (rating > threshold) return;

  const marker = `LOW_RATING_ALERT:${feedbackId}`;
  const existing = await db.notification.findFirst({
    where: { hotelId, title: { contains: feedbackId } },
    select: { id: true },
  });
  if (existing) return; // already alerted (retry safety)

  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, select: { name: true, email: true } });
  await db.notification.create({
    data: {
      hotelId,
      level: rating <= 2 ? "CRITICAL" : "WARNING",
      title: `Low rating (${rating}★) — feedback ${feedbackId.slice(0, 8)} ${marker}`,
      message: comment
        ? `A guest rated ${rating}★: “${comment.slice(0, 300)}”. Review and respond from the Feedback screen.`
        : `A guest rated ${rating}★ without a comment. Review from the Feedback screen.`,
      metadata: JSON.stringify({ feedbackId, rating, marker }),
    },
  });

  if (hotel?.email) {
    await sendEmailWithRetry({
      to: hotel.email,
      subject: `[Alert] ${rating}★ feedback at ${hotel.name}`,
      html: `<p>A guest just rated their experience <b>${rating}★</b>.</p>${comment ? `<p>“${comment.replace(/</g, "&lt;")}”</p>` : ""}<p>Open the Feedback screen to review and respond.</p>`,
      text: `A guest just rated their experience ${rating}★. ${comment ?? ""} Open the Feedback screen to review.`,
      kind: "LOW_RATING_ALERT",
    });
  }
}
