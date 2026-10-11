import { db } from "@/lib/db";
import {
  requireAuth,
  jsonError,
  readJson,
  serverError,
  getTenantCustomer,
} from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/customers/[id]/consent — record marketing consent (opt-in).
 * Sets marketingConsent=true, clears optOut, stamps timestamp + source.
 * Future campaign engine MUST check this flag before sending.
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

    const body = (await readJson(req)) || {};
    const source = typeof body.source === "string" && body.source ? body.source : "MANUAL_ENTRY";

    const updated = await db.customer.update({
      where: { id: customer.id },
      data: {
        marketingConsent: true,
        optOut: false,
        consentTimestamp: new Date(),
        consentSource: source,
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CONSENT_GRANTED,
      entityType: "customer",
      entityId: customer.id,
      metadata: { source },
    });

    return Response.json({ customer: updated });
  } catch (err) {
    return serverError(err, "Consent could not be recorded. Please try again.");
  }
}
