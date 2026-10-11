/**
 * GET /api/health/live — LIVENESS probe (Phase 7 spec §30; audit fix: the old
 * single /api/health endpoint mixed liveness and readiness, so restarts and
 * readiness withdrawals could not be told apart).
 *
 * Liveness answers exactly one question: is this process able to execute code
 * and serve HTTP? It performs NO dependency checks — a database outage must
 * withdraw the instance from rotation (readiness, /api/health) without
 * killing the container (which would hide the problem behind restart loops).
 *
 * Docker/compose healthchecks and orchestrators that restart wedged
 * containers should probe THIS endpoint; load balancers that route traffic
 * should probe /api/health (readiness). Both stay low-information.
 */
export async function GET() {
  return Response.json(
    { ok: true },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const dynamic = "force-dynamic";
