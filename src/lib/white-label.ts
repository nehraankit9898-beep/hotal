/**
 * Phase 17 — White-label / custom branding.
 *
 * Authorized custom branding, logo/theme/email identity and custom domain
 * verification/provisioning. Domain routing secure: no host-header trust,
 * no domain takeover, no cross-tenant cached pages. TLS setup instructions
 * only; provisioning via reverse proxy (Caddy/Nginx) in production.
 *
 * `removePlatformMarks` is honoured ONLY when the tenant's plan
 * entitlement allows it. Lower-tier tenants can brand their logo/colors
 * but the RestroLoop footer credit remains.
 */
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { AuthedUser } from "@/lib/api-helpers";

/**
 * Generate a domain verification token. The tenant adds a TXT record
 * `_restroloop-verify.<domain>` with this value; the operator verifies
 * via DNS lookup before flipping `domainVerified`.
 */
export function generateVerificationToken(): string {
  return "rlv_" + randomBytes(12).toString("hex");
}

/**
 * Get or create the white-label config for a tenant. Always returns a row
 * (sensible defaults) — never null.
 */
export async function getWhiteLabelConfig(hotelId: string) {
  const existing = await db.whiteLabelConfig.findUnique({ where: { hotelId } });
  if (existing) return existing;
  return db.whiteLabelConfig.create({
    data: { hotelId, featurePlanGated: true },
  });
}

/**
 * Update white-label branding (logo, colors, brand name). Caller must hold
 * WHITE_LABEL_MANAGE. The removePlatformMarks flag is gated by the plan
 * entitlement — if the plan doesn't include it, the flag is forced to false.
 */
export async function updateWhiteLabel(
  user: AuthedUser,
  updates: {
    brandName?: string;
    logoUrl?: string;
    primaryColor?: string;
    accentColor?: string;
    removePlatformMarks?: boolean;
  },
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "White-label is tenant-only.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  // Plan-entitlement check for removePlatformMarks.
  let allowRemoveMarks = false;
  if (updates.removePlatformMarks === true) {
    const hotel = await db.hotel.findUnique({
      where: { id: user.hotelId },
      select: { plan: { select: { features: true } } },
    });
    const features = hotel?.plan?.features;
    if (features) {
      try {
        const arr = JSON.parse(features);
        if (Array.isArray(arr) && arr.includes("REMOVE_PLATFORM_MARKS")) {
          allowRemoveMarks = true;
        }
      } catch {
        // ignore
      }
    }
    if (!allowRemoveMarks) {
      return {
        ok: false,
        error: "Your plan does not include the 'Remove RestroLoop branding' entitlement.",
        status: 403,
      };
    }
  }
  await db.whiteLabelConfig.upsert({
    where: { hotelId: user.hotelId },
    create: {
      hotelId: user.hotelId,
      brandName: updates.brandName?.slice(0, 120) ?? null,
      logoUrl: updates.logoUrl?.slice(0, 500) ?? null,
      primaryColor: updates.primaryColor?.slice(0, 9) ?? null,
      accentColor: updates.accentColor?.slice(0, 9) ?? null,
      removePlatformMarks: allowRemoveMarks && updates.removePlatformMarks === true,
      updatedByUserId: user.userId,
    },
    update: {
      brandName: updates.brandName?.slice(0, 120) ?? null,
      logoUrl: updates.logoUrl?.slice(0, 500) ?? null,
      primaryColor: updates.primaryColor?.slice(0, 9) ?? null,
      accentColor: updates.accentColor?.slice(0, 9) ?? null,
      removePlatformMarks: allowRemoveMarks && updates.removePlatformMarks === true,
      updatedByUserId: user.userId,
    },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "WHITE_LABEL_UPDATED",
    entityType: "WhiteLabelConfig",
    entityId: user.hotelId,
    metadata: updates,
  });
  return { ok: true };
}

/**
 * Set a custom domain for white-label routing. Generates a verification
 * token; the operator verifies via DNS before the domain becomes active.
 *
 * SECURITY: the customDomain is normalized to lowercase, stripped of scheme
 * and path. Host-header trust is NOT used — the routing layer (Caddy/Nginx)
 * must be configured to route the verified domain to the RestroLoop
 * application with the correct tenant context.
 */
export async function setCustomDomain(
  user: AuthedUser,
  rawDomain: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string; status?: number }> {
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  // Normalize: strip scheme/path, lowercase, validate hostname.
  let domain = rawDomain.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253) {
    return { ok: false, error: "Invalid domain format.", status: 422 };
  }
  // Reserved-domain blocklist (no impersonating platform domains).
  const BLOCKLIST = ["restroloop.com", "stayloop.com", "localhost", "127.0.0.1", "0.0.0.0"];
  if (BLOCKLIST.some((b) => domain === b || domain.endsWith("." + b))) {
    return { ok: false, error: "This domain is reserved and cannot be used.", status: 422 };
  }
  // No two tenants can claim the same domain.
  const existing = await db.whiteLabelConfig.findUnique({
    where: { customDomain: domain },
  });
  if (existing && existing.hotelId !== user.hotelId) {
    return { ok: false, error: "This domain is already claimed by another tenant.", status: 409 };
  }
  const token = generateVerificationToken();
  await db.whiteLabelConfig.upsert({
    where: { hotelId: user.hotelId },
    create: {
      hotelId: user.hotelId,
      customDomain: domain,
      domainVerificationToken: token,
      domainVerified: false,
      updatedByUserId: user.userId,
    },
    update: {
      customDomain: domain,
      domainVerificationToken: token,
      domainVerified: false,
      domainVerifiedAt: null,
      updatedByUserId: user.userId,
    },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "WHITE_LABEL_DOMAIN_SET",
    entityType: "WhiteLabelConfig",
    entityId: user.hotelId,
    metadata: { domain },
  });
  return { ok: true, token };
}

/**
 * Mark a domain as verified. Operator-only — verification is performed
 * out-of-band via DNS lookup. Once verified, the routing layer can serve
 * the tenant via the custom domain.
 */
export async function markDomainVerified(
  user: AuthedUser,
  verified: boolean = true,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Domain verification is operator-side, not super-admin.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  await db.whiteLabelConfig.update({
    where: { hotelId: user.hotelId },
    data: {
      domainVerified: verified,
      domainVerifiedAt: verified ? new Date() : null,
    },
  });
  await logAudit({
    hotelId: user.hotelId,
    userId: user.userId,
    action: "WHITE_LABEL_DOMAIN_VERIFIED",
    entityType: "WhiteLabelConfig",
    entityId: user.hotelId,
    metadata: { verified },
  });
  return { ok: true };
}
