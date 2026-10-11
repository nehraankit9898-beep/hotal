import { NextResponse } from "next/server";

/**
 * Root API index — intentionally returns no information about the backend
 * (Phase 20/24: avoid leaking implementation details on unauthenticated paths).
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
