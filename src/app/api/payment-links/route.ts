import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { newPaymentLinkToken } from "@/lib/billing";

/**
 * Phase 15 — diner payment links.
 *
 * GET  /api/payment-links?billId= — list links for a bill
 * POST /api/payment-links — create an expiring link for an unpaid bill
 *   { billId, expiresInHours?, sendVia? }
 * PATCH /api/payment-links — { id, action: "REVOKE" }
 *
 * Links are 32-char random tokens; the public page /pay/[token] exposes only
 * amount + restaurant name. Paid/void bills auto-revoke all active links.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const billId = url.searchParams.get("billId");
    const links = await db.paymentLink.findMany({
      where: { hotelId: auth.user.hotelId, ...(billId ? { billId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, billId: true, token: true, amountMinor: true, currency: true,
        status: true, expiresAt: true, sentVia: true, paidAt: true, createdAt: true,
      },
    });
    return Response.json({ links });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PAYMENT_LINK_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");
    const billId = typeof body.billId === "string" ? body.billId : "";
    const bill = await db.bill.findFirst({ where: { id: billId, hotelId: auth.user.hotelId } });
    if (!bill) return jsonError("Bill not found.", 404, "NOT_FOUND");
    if (["PAID", "VOID", "REFUNDED"].includes(bill.status)) {
      return jsonError(`Bill is ${bill.status.toLowerCase()}; no payment link needed.`, 422, "BILL_NOT_PAYABLE");
    }

    const hours = typeof body.expiresInHours === "number" && body.expiresInHours > 0 && body.expiresInHours <= 168
      ? body.expiresInHours
      : 24;
    const amountMinor = bill.totalMinor - bill.paidMinor;
    if (amountMinor <= 0) return jsonError("Nothing due on this bill.", 422, "NOTHING_DUE");

    // Revoke stale ACTIVE links for the same bill (one live link per bill).
    await db.paymentLink.updateMany({
      where: { billId, status: "ACTIVE" },
      data: { status: "REVOKED" },
    });

    const link = await db.paymentLink.create({
      data: {
        hotelId: auth.user.hotelId!,
        billId,
        token: newPaymentLinkToken(),
        amountMinor,
        currency: bill.currency,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + hours * 3600_000),
        sentVia: typeof body.sendVia === "string" ? body.sendVia.slice(0, 20) : null,
        createdByUserId: auth.user.userId,
      },
    });
    return Response.json({ link }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "PAYMENT_LINK_MANAGE");
    if (denied) return denied;

    const body = await readJson(req);
    if (body?.action !== "REVOKE" || typeof body.id !== "string") {
      return jsonError("Expected { id, action: 'REVOKE' }.", 422, "INVALID_ACTION");
    }
    const link = await db.paymentLink.findFirst({ where: { id: body.id, hotelId: auth.user.hotelId } });
    if (!link) return jsonError("Link not found.", 404, "NOT_FOUND");
    const updated = await db.paymentLink.update({ where: { id: link.id }, data: { status: "REVOKED" } });
    return Response.json({ link: updated });
  } catch (err) {
    return serverError(err);
  }
}
