import { db } from "@/lib/db";
import { parsePlanFeatures } from "@/lib/saas/plans";

/**
 * Feature entitlement resolution — Phase 10 §3/§11 (with Phase 9 §8 semantics).
 *
 * Resolution order for `isFeatureEnabled(hotelId, key)`:
 *   1. GLOBAL kill switch: GlobalFeatureFlag with force=true → its `enabled`
 *      value wins over EVERYTHING (emergency controls, Phase 9 §18).
 *   2. PLAN gate: if the tenant's plan defines a features list and the key is
 *      NOT in it → disabled (plan controls feature availability, Phase 10 §3).
 *   3. PER-HOTEL override (TenantFeature) — explicit ON can re-enable a
 *      feature whose global default is OFF (Phase 9 §8 example).
 *   4. GLOBAL default: GlobalFeatureFlag.enabled when a record exists.
 *   5. Default: enabled.
 *
 * Scheduled activation/deactivation (activateAt / deactivateAt) is applied by
 * the background worker (processScheduledGlobalFlags) so time-based rollout
 * works without a cron-per-minute cost.
 */

export interface EntitlementSnapshot {
  key: string;
  enabled: boolean;
  source: "force-global" | "plan" | "tenant-override" | "global-default" | "default";
}

export async function isFeatureEnabled(hotelId: string, featureKey: string): Promise<boolean> {
  const snapshot = await resolveFeature(hotelId, featureKey);
  return snapshot.enabled;
}

export async function resolveFeature(
  hotelId: string,
  featureKey: string,
): Promise<EntitlementSnapshot> {
  const [globalFlag, hotel] = await Promise.all([
    db.globalFeatureFlag.findUnique({ where: { key: featureKey } }),
    db.hotel.findUnique({ where: { id: hotelId }, include: { plan: true } }),
  ]);

  // 1. Emergency / forced global switch beats everything.
  if (globalFlag?.force) {
    return { key: featureKey, enabled: globalFlag.enabled, source: "force-global" };
  }

  // 2. Plan gate — a plan that defines its feature list controls availability.
  const planFeatures = hotel?.plan ? parsePlanFeatures(hotel.plan.features) : null;
  if (planFeatures && !planFeatures.includes(featureKey)) {
    return { key: featureKey, enabled: false, source: "plan" };
  }

  // 3. Per-hotel override.
  const tenantFlag = await db.tenantFeature.findUnique({
    where: { hotelId_featureKey: { hotelId, featureKey } },
  });
  if (tenantFlag) {
    return { key: featureKey, enabled: tenantFlag.enabled, source: "tenant-override" };
  }

  // 4. Global default when configured.
  if (globalFlag) {
    return { key: featureKey, enabled: globalFlag.enabled, source: "global-default" };
  }

  return { key: featureKey, enabled: true, source: "default" };
}

/** Resolve MANY keys at once (one round-trip per table). */
export async function resolveFeatures(
  hotelId: string,
  keys: string[],
): Promise<Record<string, boolean>> {
  const results = await Promise.all(keys.map((k) => resolveFeature(hotelId, k)));
  return Object.fromEntries(results.map((r) => [r.key, r.enabled]));
}

/** Apply scheduled global flag transitions (called by the worker). */
export async function processScheduledGlobalFlags(): Promise<{
  activated: number;
  deactivated: number;
}> {
  const now = new Date();
  const toActivate = await db.globalFeatureFlag.findMany({
    where: { activateAt: { lte: now }, enabled: false },
  });
  const toDeactivate = await db.globalFeatureFlag.findMany({
    where: { deactivateAt: { lte: now }, enabled: true, force: false },
  });
  for (const flag of toActivate) {
    await db.globalFeatureFlag.update({
      where: { id: flag.id },
      data: { enabled: true, activateAt: null },
    });
  }
  for (const flag of toDeactivate) {
    await db.globalFeatureFlag.update({
      where: { id: flag.id },
      data: { enabled: false, deactivateAt: null },
    });
  }
  return { activated: toActivate.length, deactivated: toDeactivate.length };
}
