import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { reconcileAccount, type ReconcileReport } from "@/lib/loyalty";

/**
 * POST /api/loyalty/reconcile — Phase 6.4 (spec §28) admin diagnostic.
 *
 * Compares the immutable ledger total against the stored balance:
 *   { customerId }       → report drift for ONE account
 *   { customerId, repair: true } → safely repair via a compensating ADJUST entry
 *   { all: true }        → report drift for every account in the hotel
 *   { all: true, repair: true }  → repair every drifted account
 *
 * Never silently modifies balances: every repair is an audited ledger entry.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "LOYALTY_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const repair = body.repair === true;
    const all = body.all === true;
    const customerId = typeof body.customerId === "string" ? body.customerId : "";

    if (!all && !customerId) {
      return jsonError("Provide a customerId, or all:true to reconcile every member.");
    }

    if (all) {
      const accounts = await db.loyaltyAccount.findMany({
        where: { hotelId },
        select: { customerId: true },
      });
      const reports: ReconcileReport[] = [];
      for (const a of accounts) {
        reports.push(await reconcileAccount(hotelId, a.customerId, { repair, userId, req }));
      }
      const drifted = reports.filter((r) => !r.matched);
      if (drifted.length > 0) {
        await logAudit({
          req,
          hotelId,
          userId,
          action: AUDIT_ACTIONS.LOYALTY_RECONCILED,
          entityType: "loyalty_account",
          metadata: {
            mode: "ALL",
            checked: reports.length,
            drifted: drifted.length,
            repaired: repair,
          },
        });
      }
      return Response.json({
        checked: reports.length,
        drifted: drifted.length,
        repaired: repair ? drifted.length : 0,
        reports: drifted.length ? drifted : reports.slice(0, 50),
      });
    }

    const customer = await db.customer.findFirst({
      where: { id: customerId, hotelId },
      select: { id: true, name: true },
    });
    if (!customer) return jsonError("Customer not found in your hotel.", 404, "NOT_FOUND");

    const report = await reconcileAccount(hotelId, customerId, { repair, userId, req });
    if (!report.matched || repair) {
      await logAudit({
        req,
        hotelId,
        userId,
        action: AUDIT_ACTIONS.LOYALTY_RECONCILED,
        entityType: "loyalty_account",
        entityId: report.accountId,
        metadata: { customerId, drift: report.drift, repaired: repair },
      });
    }
    return Response.json({ report });
  } catch (err) {
    return serverError(err, "Reconciliation could not be run. Please try again.");
  }
}
