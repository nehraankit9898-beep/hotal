import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateCustomerCsv } from "@/lib/import";
import { CsvShapeError } from "@/lib/import";
import { guardCsvPayload } from "@/lib/csv-guard";
import { sanitizeCsvRow } from "@/lib/csv-guard";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { createCustomerWithinLimit } from "@/lib/saas/limits";

/** POST /api/imports/customers — import validated rows (skips duplicates/invalid with full report). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_CREATE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    // RECHECK FIX (I): the plan's customer capacity is enforced INSIDE the
    // create transaction (bulk headroom included) — the old pre-parse
    // pre-check let a concurrent import/API/UI burst push past the cap.
    // NOTE: validateCustomerCsv below already counts EXISTING phones as
    // "duplicates", so validRows never collide with live rows.

    const body = await readJson(req);
    if (!body || typeof body.csv !== "string") {
      return jsonError("Please provide the CSV content to import.");
    }

    // Phase 19: size/row/column guards before parsing.
    const guard = guardCsvPayload(body.csv);
    if (!guard.ok) return jsonError(guard.reason ?? "CSV rejected.", 413, "PAYLOAD_TOO_LARGE");

    const { rows, summary } = await validateCustomerCsv(body.csv, hotelId);
    const validRows = rows.filter((r) => r.status === "valid");

    let imported = 0;
    if (validRows.length > 0) {
      const result = await createCustomerWithinLimit(
        hotelId,
        (tx) =>
          tx.customer.createMany({
            data: validRows.map((r) => ({
              hotelId,
              name: r.name,
              phone: r.phone,
              email: r.email || null,
              marketingConsent: r.consent,
              consentTimestamp: r.consent ? new Date() : null,
              consentSource: r.consent ? "CSV_IMPORT" : null,
              optOut: false,
            })),
          }),
        { requested: validRows.length },
      );
      if (!result.ok) {
        return jsonError(result.failure.message, 403, result.failure.code);
      }
      imported = result.value.count;
    }

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.CUSTOMERS_IMPORTED,
      entityType: "customer",
      metadata: { imported, duplicates: summary.duplicates, invalid: summary.invalid },
    });

    return Response.json({
      summary: {
        total: summary.total,
        imported,
        duplicates: summary.duplicates,
        invalid: summary.invalid,
      },
      // Phase 19: neutralize spreadsheet formula injection in echoed values.
      rows: rows.map((r) => {
        const s = sanitizeCsvRow([r.name, r.email, r.reason ?? ""]) as string[];
        return { ...r, name: s[0], email: s[1], reason: s[2] || undefined };
      }),
    });
  } catch (err) {
    if (err instanceof CsvShapeError) return jsonError(err.message, 413, "PAYLOAD_TOO_LARGE");
    return serverError(err, "Import could not be completed. Please try again.");
  }
}
