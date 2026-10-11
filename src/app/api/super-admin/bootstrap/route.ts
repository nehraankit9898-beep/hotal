import { NextResponse } from "next/server";
import { timingSafeEqual, createHash } from "crypto";
import { getAdminBootstrapSecret } from "@/lib/config";
import { bootstrapFirstSuperAdmin } from "@/lib/super-admin";
import { db } from "@/lib/db";
import { z } from "zod";
import { parseWith } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { requestIp } from "@/lib/login-security";
import { checkRateLimit } from "@/lib/rate-limit";

const bootstrapBodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
});

/**
 * POST /api/super-admin/bootstrap — one-time Super Admin provisioning.
 *
 * Requirements (Phase 2):
 *   - ADMIN_BOOTSTRAP_SECRET must be configured and supplied via the
 *     `x-bootstrap-secret` header.
 *   - Works ONLY while no Super Admin exists (single-use by construction).
 *   - Generates a cryptographically random temporary password, returned ONCE
 *     in this response; the account cannot use the platform until the password
 *     is changed (mustChangePassword).
 *   - The bootstrap secret itself is never stored or logged.
 */
export async function POST(req: Request) {
  try {
    const burst = await checkRateLimit(`sa-bootstrap:${requestIp(req)}`, 5, 60 * 1000);
    if (!burst.allowed) {
      return NextResponse.json(
        {
          error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait and try again." },
        },
        { status: 429 },
      );
    }

    const configuredSecret = getAdminBootstrapSecret();
    if (!configuredSecret) {
      // Fail closed: bootstrap disabled unless explicitly configured.
      return NextResponse.json(
        {
          error: {
            code: "BOOTSTRAP_DISABLED",
            message: "Bootstrap is not enabled on this deployment.",
          },
        },
        { status: 403 },
      );
    }

    const provided = req.headers.get("x-bootstrap-secret") ?? "";
    // SECURITY FIX: constant-time comparison (a plain !== leaks the secret's
    // prefix through response timing). Both sides are hashed first so the
    // lengths match and the length itself does not leak either.
    const digest = (v: string) => createHash("sha256").update(v).digest();
    const secretOk = timingSafeEqual(digest(provided), digest(configuredSecret));
    if (!secretOk) {
      await logAudit({
        req,
        action: "BOOTSTRAP_DENIED",
        entityType: "user",
        metadata: { reason: "invalid bootstrap secret" },
        ipAddress: requestIp(req),
      });
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid bootstrap secret." } },
        { status: 401 },
      );
    }

    const existingCount = await db.user.count({ where: { role: "SUPER_ADMIN" } });
    if (existingCount > 0) {
      return NextResponse.json(
        { error: { code: "ALREADY_BOOTSTRAPPED", message: "A Super Admin already exists." } },
        { status: 409 },
      );
    }

    const body = await req.json().catch(() => null);
    const parsed = parseWith(bootstrapBodySchema, body);
    if (!parsed.ok || !parsed.data) {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: parsed.error ?? "name and email are required." } },
        { status: 400 },
      );
    }

    const result = await bootstrapFirstSuperAdmin({
      name: parsed.data.name,
      email: parsed.data.email,
      bootstrapSecret: configuredSecret,
    });

    return NextResponse.json(
      {
        ok: true,
        admin: { id: result.id, email: result.email },
        // One-time temporary password — the operator must hand it to the admin
        // over a secure channel. Never returned again; never logged.
        temporaryPassword: result.temporaryPassword,
        mustChangePassword: true,
        message: "Store this temporary password securely now — it will not be shown again.",
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bootstrap failed.";
    return NextResponse.json({ error: { code: "BAD_REQUEST", message } }, { status: 400 });
  }
}
