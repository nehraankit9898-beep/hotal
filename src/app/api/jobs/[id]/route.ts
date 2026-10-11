import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/[id] — status of a background job (Phase 7 spec §15/§19).
 * Tenant-scoped: only the owning hotel's users (or the creating super admin)
 * can see the job. Foreign IDs return 404 (indistinguishable from missing).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const { id } = await ctx.params;

    const job = await db.backgroundJob.findFirst({
      where: {
        id,
        OR: [{ hotelId: auth.user.hotelId }, { createdBy: auth.user.userId, hotelId: null }],
      },
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        result: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!job) return jsonError("Job not found.", 404, "NOT_FOUND");

    const result = job.result ? safeParse(job.result) : null;
    return Response.json({
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lastError: job.lastError,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        result,
      },
    });
  } catch (err) {
    return serverError(err, "Could not load the job status.");
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
