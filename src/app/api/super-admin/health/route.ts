import { NextResponse } from "next/server";
import { requireSuperAdminSession } from "@/lib/api-helpers";
import { getSystemHealth } from "@/lib/super-admin";

/** GET /api/super-admin/health — system health checks (Super Admin only). */
export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;

  try {
    const checks = await getSystemHealth();
    return Response.json({ checks, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("[super-admin/health] error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Could not load system health." } },
      { status: 500 },
    );
  }
}
