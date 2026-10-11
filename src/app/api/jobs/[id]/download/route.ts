import fs from "fs";

import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { db } from "@/lib/db";
import {
  resolveExportFilePath,
  verifyExportToken,
  EXPORT_FILE_TTL_HOURS,
} from "@/lib/jobs/handlers";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/[id]/download?token=… — stream a completed export file.
 *
 * This route was MISSING from the delivered ZIP (confirmed audit finding): the
 * CSV export job wrote the file to disk and signed a download token into the
 * job result, but there was no route to actually fetch it — queued exports
 * were broken end-to-end.
 *
 * Security contract (mirrors the job-status route + handler helpers):
 *  1. Authenticated session required (anonymous → 401 before any DB read).
 *  2. Tenant ownership: only the owning hotel's users (or the creating
 *     super-admin agent for platform jobs) see the job. Foreign/unknown ids
 *     return 404 — indistinguishable, so job existence never leaks.
 *  3. Job must be a COMPLETED CSV_EXPORT (failed/pending → 409; a pending
 *     job's id is not a download right).
 *  4. The HMAC-signed token from the job RESULT must verify (constant-time) —
 *     knowing the job id alone is not enough. Forged/missing → 403.
 *  5. The stored filename (from the job result row, never the request) is
 *     resolved through resolveExportFilePath: bare filename only, must live
 *     inside the exports directory — path traversal is structurally rejected.
 *  6. Files older than the TTL (24 h) are gone/stale → 410.
 *  7. Streamed with Content-Disposition: attachment, correct MIME type and
 *     no-cache headers (signed URLs are single-purpose, not shareable CDN).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    // 1. Authentication first — anonymous callers never learn whether a job
    // id exists (no 401/404 oracle difference between unknown vs foreign).
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;

    // D04 — ROLE authorization: possessing a signed token is NOT a substitute
    // for holding the permission the export requires. A CSV customer export
    // needs CUSTOMER_READ (the same permission the /api/export/customers
    // route enforces) — a kitchen user with a leaked/copied token gets 403,
    // and so does anyone whose role changed after the export was created.
    const denied = requirePermission(auth.user, "CUSTOMER_READ");
    if (denied) return denied;

    const { id } = await ctx.params;

    // 2. Tenant-scoped lookup FIRST — unknown/foreign jobs are 404 regardless
    // of whether a token was supplied (no existence oracle; matches the job
    // status route's contract).
    const job = await db.backgroundJob.findFirst({
      where: {
        id,
        OR: [{ hotelId: auth.user.hotelId }, { createdBy: auth.user.userId, hotelId: null }],
      },
      select: {
        id: true,
        type: true,
        status: true,
        result: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!job) return jsonError("Job not found.", 404, "NOT_FOUND");

    // Token must be present for any OWNED job (checked after the 404 so the
    // response for unknown jobs never depends on token presence).
    const url = new URL(req.url);
    const token = url.searchParams.get("token") ?? "";
    if (!token) {
      return jsonError(
        "Missing download token. Use the download link from the export job.",
        403,
        "FORBIDDEN",
      );
    }

    // 3. Only completed export jobs expose a download.
    if (job.type !== "CSV_EXPORT") {
      return jsonError("This job has no downloadable file.", 404, "NOT_FOUND");
    }
    if (job.status !== "COMPLETED") {
      return jsonError(
        job.status === "FAILED"
          ? "This export failed — no file is available. Start a new export."
          : job.status === "RUNNING"
            ? "This export is still running. Try again shortly."
            : "This export is not ready for download.",
        409,
        "JOB_NOT_COMPLETED",
      );
    }

    // 4. Verify the signed token (constant-time compare inside).
    if (!verifyExportToken(job.id, token)) {
      return jsonError("Invalid or expired download token.", 403, "FORBIDDEN");
    }

    // 5. Resolve the file path from the job RESULT (never request input) with
    // strict traversal defense.
    let result: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(job.result ?? "{}");
      if (typeof parsed === "object" && parsed !== null) result = parsed as Record<string, unknown>;
    } catch {
      /* fall through with empty result */
    }
    const filename = typeof result.file === "string" ? result.file : "";
    if (!filename) {
      return jsonError("This job did not record an export file.", 404, "NOT_FOUND");
    }
    const filePath = resolveExportFilePath(filename);
    if (!filePath) {
      // Tampered/legacy result with an unsafe filename — never readable.
      return jsonError("This export file is no longer available.", 404, "NOT_FOUND");
    }

    // 6. Existence + TTL: the worker purges expired files hourly, but a file
    // can outlive the sweep — enforce the TTL at read time too.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return jsonError(
        "This export file has expired and was removed. Start a new export.",
        410,
        "FILE_EXPIRED",
      );
    }
    const ttlMs = EXPORT_FILE_TTL_HOURS * 60 * 60 * 1000;
    if (Date.now() - stat.mtimeMs > ttlMs) {
      return jsonError(
        "This export file has expired and was removed. Start a new export.",
        410,
        "FILE_EXPIRED",
      );
    }

    // 7. Stream the file — attachment disposition (never inline; a CSV can
    // carry formula-injection payloads when opened in a spreadsheet app, and
    // inline rendering would execute it in the app origin), no-cache so the
    // signed URL is never silently reused after revocation/expiry.
    const stream = fs.createReadStream(filePath);
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(stat.size),
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return serverError(err, "Could not download the export file.");
  }
}
