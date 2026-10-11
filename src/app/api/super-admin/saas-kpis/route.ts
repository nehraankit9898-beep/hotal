/**
 * Phase 17 — Super Admin: SaaS financial KPIs (MRR/ARR/churn).
 * GET /api/super-admin/saas-kpis
 */
import { NextResponse } from "next/server";
import { requireSuperAdminSession, jsonOk, serverError } from "@/lib/api-helpers";
import { computeSaasKpis } from "@/lib/saas/refunds";

export async function GET(req: Request) {
  try {
    const auth = await requireSuperAdminSession(req);
    if ("response" in auth) return auth.response;
    const kpis = await computeSaasKpis();
    return jsonOk({
      ...kpis,
      definitions: {
        mrr: "Sum of (amount for ACTIVE subscriptions), normalized to monthly: YEARLY/12, MONTHLY as-is, QUARTERLY/3.",
        arr: "MRR × 12. Annualized recurring revenue; not used internally for billing.",
        activeSubscriptions: "Count of subscriptions with status ACTIVE.",
        cancelledThisMonth: "Subscriptions that moved to CANCELLED in the current month.",
        churnRatePct: "(cancelledThisMonth / activeAtMonthStart) × 100. Simple monthly churn; cohort churn computed separately.",
      },
    });
  } catch (e) {
    return serverError(e);
  }
}
