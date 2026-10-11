import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { validateCustomerCsv } from "@/lib/import";
import { CsvShapeError } from "@/lib/import";
import { guardCsvPayload, sanitizeCsvRow } from "@/lib/csv-guard";

/** POST /api/imports/customers/preview — validate CSV and return row-level results (no writes). */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "CUSTOMER_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body || typeof body.csv !== "string") {
      return jsonError("Please provide the CSV content to preview.");
    }
    const guard = guardCsvPayload(body.csv);
    if (!guard.ok) return jsonError(guard.reason ?? "CSV rejected.", 413, "PAYLOAD_TOO_LARGE");

    const { rows, summary } = await validateCustomerCsv(body.csv, auth.user.hotelId);
    // Phase 19: neutralize spreadsheet formula injection in echoed values.
    return Response.json({
      summary,
      rows: rows.map((r) => {
        const s = sanitizeCsvRow([r.name, r.email, r.reason ?? ""]) as string[];
        return { ...r, name: s[0], email: s[1], reason: s[2] || undefined };
      }),
    });
  } catch (err) {
    if (err instanceof CsvShapeError) return jsonError(err.message, 413, "PAYLOAD_TOO_LARGE");
    return serverError(
      err,
      "Could not preview this file. Please check the CSV format and try again.",
    );
  }
}
