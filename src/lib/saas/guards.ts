import { jsonError } from "@/lib/api-helpers";
import { assertWithinLimit } from "@/lib/saas/limits";
import { isFeatureEnabled } from "@/lib/saas/entitlements";

/**
 * Route-level SaaS guards — Phase 10 §11/§12.
 *
 * Thin wrappers so existing tenant routes stay readable:
 *
 *   const limited = await enforcePlanLimit(hotelId, "customers");
 *   if (limited) return limited;
 *
 *   const blocked = await enforceFeature(hotelId, "RESTAURANT_CRM");
 *   if (blocked) return blocked;
 *
 * Backend enforcement ONLY — the frontend hides/disables UI as UX, never as
 * the actual control.
 */

/** Returns a 403 SUBSCRIPTION_LIMIT_REACHED response or null. */
export async function enforcePlanLimit(
  hotelId: string,
  resource: Parameters<typeof assertWithinLimit>[1],
): Promise<ReturnType<typeof jsonError> | null> {
  const failure = await assertWithinLimit(hotelId, resource);
  if (failure) {
    return jsonError(failure.message, 403, failure.code);
  }
  return null;
}

/** Returns a 403 FEATURE_DISABLED response or null. */
export async function enforceFeature(
  hotelId: string,
  featureKey: string,
): Promise<ReturnType<typeof jsonError> | null> {
  const enabled = await isFeatureEnabled(hotelId, featureKey);
  if (!enabled) {
    return jsonError(
      `The ${featureKey.replace(/_/g, " ").toLowerCase()} feature is not included in your current plan. Upgrade to continue.`,
      403,
      "FEATURE_DISABLED",
    );
  }
  return null;
}
