import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateVisitCsv } from "@/lib/import";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { parseCsvDate } from "@/lib/csv";
import { CsvShapeError } from "@/lib/import";
import { guardCsvPayload, sanitizeCsvRow } from "@/lib/csv-guard";

/** POST /api/imports/visits — import validated visit rows (full failure report). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "VISIT_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // NOTE: visits are not plan-metered (plans limit customers; visits belong
    // to customers), so no enforcePlanLimit here — matches LimitResource union.

    const body = await readJson(req);
    if (!body || typeof body.csv !== "string") {
      return jsonError("Please provide the CSV content to import.");
    }

    // Phase 19: size/row guards before parsing.
    const guard = guardCsvPayload(body.csv);
    if (!guard.ok) return jsonError(guard.reason ?? "CSV rejected.", 413, "PAYLOAD_TOO_LARGE");

    const { rows, summary } = await validateVisitCsv(body.csv, hotelId);
    const validRows = rows.filter((r) => r.status === "valid");

    let imported = 0;
    if (validRows.length > 0) {
      // Look up customer ids by normalized phone
      const phones = [...new Set(validRows.map((r) => r.customerPhone))];
      const customers = await db.customer.findMany({
        where: { hotelId, phone: { in: phones } },
        select: { id: true, phone: true },
      });
      const phoneToId = new Map(customers.map((c) => [c.phone, c.id]));

      const result = await db.visit.createMany({
        data: validRows
          .filter((r) => phoneToId.has(r.customerPhone))
          .map((r) => ({
            hotelId,
            customerId: phoneToId.get(r.customerPhone)!,
            checkin: parseCsvDate(r.checkin)!,
            checkout: r.checkout ? parseCsvDate(r.checkout) : null,
            source: "CSV_IMPORT",
          })),
      });
      imported = result.count;
    }

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.VISITS_IMPORTED,
      entityType: "visit",
      metadata: { imported, invalid: summary.invalid },
    });

    return Response.json({
      summary: { total: summary.total, imported, invalid: summary.invalid },
      // Phase 19: neutralize formula injection in echoed values.
      rows: rows.map((r) => {
        const s = sanitizeCsvRow([r.customerName ?? "", r.reason ?? ""]) as string[];
        return { ...r, customerName: s[0] || undefined, reason: s[1] || undefined };
      }),
    });
  } catch (err) {
    if (err instanceof CsvShapeError) return jsonError(err.message, 413, "PAYLOAD_TOO_LARGE");
    return serverError(err, "Import could not be completed. Please try again.");
  }
}
