import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";

/**
 * Public QR landing router — Phase 6.3 + Phase 12.
 *
 * /r/[code] is the URL embedded in every printed QR. The code's TYPE decides
 * where the diner lands:
 *   - MENU / ORDER → the digital menu + ordering page (/menu/[code])
 *   - LOYALTY / FEEDBACK → the original QR landing page (join/feedback flow)
 *
 * The type lookup is server-side (the code is the capability; the client
 * never gets to choose the destination). Unknown/inactive codes 404.
 */
export default async function PublicQrRouter({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const clean = code.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) notFound();

  const qr = await db.qRCode.findUnique({
    where: { code: clean },
    select: { type: true, active: true },
  });
  if (!qr || !qr.active) notFound();

  if (qr.type === "MENU" || qr.type === "ORDER") {
    redirect(`/menu/${clean}`);
  }

  const { PublicRestaurantClient } = await import("@/components/public/restaurant-page");
  return <PublicRestaurantClient code={clean} />;
}
