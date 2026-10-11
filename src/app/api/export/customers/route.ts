import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { buildCustomersCsv } from "@/lib/export-customers";
import { enqueueJob, queueDepth } from "@/lib/queue";
import { exportInlineMaxRows } from "@/lib/env";
import { reserveUsage, releaseUsage } from "@/lib/saas/limits";

/**
 * Customer data export — Phase 6.3 (spec §52), extended in Phase 7 (spec §19).
 * GET /api/export/customers?format=csv — consent-aware CSV of the hotel's own
 * customers. Tenant-scoped, audited (DATA_EXPORT), formula-injection safe.
 *
 * Phase 7: exports above EXPORT_INLINE_MAX_ROWS (default 5000) are moved to a
 * background job (HTTP 202 + jobId) so no huge CSV is built inside server
 * memory or one request. The result is fetched via /api/jobs/[id]/download.
 *
 * AUDIT FIX (quota-1): the monthly export limit is now an ATOMIC RESERVATION
 * (reserveUsage) instead of a check-only guard — the counter is incremented
 * under the `used < limit` guard in a single update, so concurrent requests
 * can never exceed the plan limit and the counter actually moves (the old
 * code never incremented `exports` at all, making exportsLimit decorative).
 * The reservation is released when the export fails server-side.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // Phase 10 §12 — monthly export limit enforced server-side (RESERVED
    // atomically — see quota-1 note above).
    const limited = await reserveUsage(hotelId, "exports");
    if (limited) {
      return new Response(
        JSON.stringify({ error: { code: limited.code, message: limited.message } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const asyncParam = new URL(req.url).searchParams.get("async");
    const totalRows = await db.customer.count({ where: { hotelId } });

    if (asyncParam !== "false" && totalRows > exportInlineMaxRows()) {
      const depth = await queueDepth();
      if (depth.queued + depth.running >= 100) {
        // Queue is saturated — this request never produced anything: give the
        // reservation back so the tenant does not pay quota for a 429.
        await releaseUsage(hotelId, "exports").catch(() => undefined);
        return new Response(
          JSON.stringify({
            error: {
              code: "EXPORT_BUSY",
              message: "Too many exports in progress. Please try again shortly.",
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      const jobId = await enqueueJob(
        "CSV_EXPORT",
        { hotelId, entity: "customers", requestedRows: totalRows },
        { hotelId, createdBy: userId },
      );
      await logAudit({
        req,
        hotelId,
        userId,
        action: AUDIT_ACTIONS.EXPORT_QUEUED,
        entityType: "background_job",
        entityId: jobId,
        metadata: { format: "csv", rows: totalRows },
      });
      return Response.json(
        {
          queued: true,
          jobId,
          rows: totalRows,
          message: "Your export is being generated. Poll /api/jobs/" + jobId + " for status.",
        },
        { status: 202 },
      );
    }

    let csv: string;
    let rows: number;
    try {
      ({ csv, rows } = await buildCustomersCsv(hotelId));
    } catch (err) {
      // Inline build failed — the tenant got nothing; do not burn quota.
      await releaseUsage(hotelId, "exports").catch(() => undefined);
      throw err;
    }

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.DATA_EXPORT,
      entityType: "customer_list",
      metadata: { format: "csv", rows },
    });

    const filename = `stayloop-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { code: "SERVER_ERROR", message: "Export failed." } }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
