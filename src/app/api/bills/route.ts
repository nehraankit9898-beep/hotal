import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { createBillFromSession, BillValidationError } from "@/lib/billing";

/**
 * Phase 14 — bills (POS invoices).
 *
 * GET  /api/bills?status=&from=&to=&limit= — tenant-scoped bill list
 * POST /api/bills — create a bill from a table session's orders.
 *   Body: { tableSessionId?, orderIds?, couponCode?, customerId?,
 *           customerName?, customerPhone?, notes?, manualDiscountMinor?,
 *           manualDiscountReason?, idempotencyKey? }
 *   Manual discounts are audited against the acting user; coupons require a
 *   customer attachment (redemption history).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_READ");
    if (denied) return denied;

    const url = new URL(req.url);
    const statuses = url.searchParams.getAll("status").filter((s) =>
      ["ISSUED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOID"].includes(s),
    );
    const sessionId = url.searchParams.get("sessionId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

    const bills = await db.bill.findMany({
      where: {
        hotelId: auth.user.hotelId,
        ...(statuses.length > 0 ? { status: { in: statuses as never[] } } : {}),
        ...(sessionId ? { tableSessionId: sessionId } : {}),
        ...(from || to
          ? {
              issuedAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { issuedAt: "desc" },
      take: limit,
      select: {
        id: true,
        billNumber: true,
        series: true,
        status: true,
        tableSessionId: true,
        table: { select: { id: true, number: true, zone: true } },
        currency: true,
        subtotalMinor: true,
        discountMinor: true,
        taxMinor: true,
        totalMinor: true,
        paidMinor: true,
        refundMinor: true,
        couponCode: true,
        customerName: true,
        customerPhone: true,
        issuedAt: true,
        paidAt: true,
        issuedByUserId: true,
      },
    });
    return Response.json({ bills });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BILL_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 400, "BAD_REQUEST");

    const tableSessionId = typeof body.tableSessionId === "string" ? body.tableSessionId : null;
    const orderIds = Array.isArray(body.orderIds)
      ? (body.orderIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100)
      : undefined;
    const manualDiscountMinor =
      typeof body.manualDiscountMinor === "number" && Number.isFinite(body.manualDiscountMinor)
        ? Math.max(0, Math.floor(body.manualDiscountMinor))
        : undefined;
    // Manual discount > 0 needs elevated rights: managers/owners hold
    // RESTAURANT_WRITE; the CASHIER role does not.
    if (manualDiscountMinor && manualDiscountMinor > 0) {
      const elevated = requirePermission(auth.user, "RESTAURANT_WRITE");
      if (elevated) {
        return jsonError(
          "Manual discounts beyond coupons require manager approval.",
          403,
          "FORBIDDEN",
        );
      }
    }

    try {
      const bill = await createBillFromSession({
        hotelId: auth.user.hotelId,
        issuedByUserId: auth.user.userId,
        tableSessionId,
        orderIds: orderIds && orderIds.length > 0 ? orderIds : undefined,
        couponCode: typeof body.couponCode === "string" ? body.couponCode : undefined,
        customerId: typeof body.customerId === "string" ? body.customerId : null,
        customerName: typeof body.customerName === "string" ? body.customerName : null,
        customerPhone: typeof body.customerPhone === "string" ? body.customerPhone : null,
        notes: typeof body.notes === "string" ? body.notes : null,
        manualDiscountMinor,
        manualDiscountReason:
          typeof body.manualDiscountReason === "string" ? body.manualDiscountReason : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
      });
      return Response.json({ bill }, { status: 201 });
    } catch (err) {
      if (err instanceof BillValidationError) {
        return jsonError(err.message, 422, err.code);
      }
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}
