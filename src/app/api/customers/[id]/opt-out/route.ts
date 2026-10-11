import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError, getTenantCustomer } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/opt-out — record marketing opt-out.
 * marketing_consent = false, opt_out = true.
 * Every future messaging system must respect this before sending.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_UPDATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const customer = await getTenantCustomer(id, hotelId);
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const updated = await db.customer.update({
      where: { id: customer.id },
      data: {
        marketingConsent: false,
        optOut: true,
        consentTimestamp: new Date(),
        consentSource: "OPT_OUT",
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.OPT_OUT,
      entityType: "customer",
      entityId: customer.id,
      metadata: { name: customer.name },
    });

    return Response.json({ customer: updated });
  } catch (err) {
    return serverError(err, "Opt-out could not be recorded. Please try again.");
  }
}
