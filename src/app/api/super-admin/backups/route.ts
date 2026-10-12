import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { getBackupStatus, triggerBackup, verifyLatestBackup } from "@/lib/saas/backup";
import type { BackupHistoryRow } from "@/lib/types";

/**
 * Backup & disaster recovery — Super Admin only (Phase 10 §16).
 *   GET  /api/super-admin/backups           → { status, history } for the dashboard
 *   POST /api/super-admin/backups           → { reason } queues a manual backup;
 *                                             the worker (processPendingBackups)
 *                                             runs it within seconds
 *   POST /api/super-admin/backups?verify=1  → AES-256-GCM decrypt-verifies the
 *                                             latest successful archive
 * Responses carry filenames, sizes and status only — never paths or credentials.
 *
 * BUG FIX: the Super Admin Backups page, the Phase 10 suite and the PostgreSQL
 * integration script all call this route, but it was never committed: the
 * unanchored `backups/` rule in .gitignore matched this directory, so every
 * build from git answered 404.
 */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const [status, records] = await Promise.all([
      getBackupStatus(),
      db.backupRecord.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    const history: BackupHistoryRow[] = records.map((r) => ({
      id: r.id,
      status: r.status,
      filename: r.filename,
      sizeBytes: r.sizeBytes,
      verified: Boolean(r.verifiedAt),
      error: r.error,
      durationMs: r.durationMs,
      reason: r.triggerReason,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return NextResponse.json({ status, history });
  } catch (err) {
    return serverError(err, "Could not load backup status.");
  }
}

export async function POST(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    if (new URL(req.url).searchParams.get("verify") === "1") {
      const result = await verifyLatestBackup(guard.session.userId);
      return NextResponse.json({
        ok: result.ok,
        reason: result.reason ?? null,
        recordId: result.recordId ?? null,
      });
    }
    const body = await readJson(req);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) {
      return jsonError("A reason (3-500 characters) is required to trigger a backup.", 422, "VALIDATION_ERROR");
    }
    const queued = await triggerBackup({ triggeredBy: guard.session.userId, reason });
    return NextResponse.json({
      ok: true,
      status: "QUEUED",
      recordId: queued.recordId,
      filename: null,
      sizeBytes: 0,
      error: null,
    });
  } catch (err) {
    return serverError(err, "Could not queue the backup.");
  }
}
