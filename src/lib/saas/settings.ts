import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Platform Settings — Phase 10.
 *
 * The database is the single source of truth for every SaaS control knob:
 * trial defaults, MFA policy, maintenance mode, billing providers, backup
 * schedule, data retention and security policy. Nothing SaaS-related is
 * hardcoded in the frontend; the Super Admin UI reads/writes these values
 * through /api/super-admin/settings and the running application enforces
 * them server-side.
 *
 * Values are stored as JSON strings in PlatformSetting and exposed through
 * typed accessors with safe defaults (a missing/corrupt row falls back to the
 * default rather than throwing).
 */

export interface TrialDefaults {
  defaultDays: number;
  minDays: number;
  maxDays: number;
  graceDays: number;
  /** Plan key new self-registered trials start on (Super Admin configurable). */
  defaultPlanKey: string;
  /** Auto-transition TRIAL → GRACE → EXPIRED via the background worker. */
  autoExpire: boolean;
  /** When true, EXPIRED tenants are blocked from non-essential APIs. */
  blockOnExpiry: boolean;
}

export interface MfaPolicy {
  /** Roles that MUST enrol in MFA before full platform access. */
  requiredRoles: string[];
  /** Allow login but restrict to MFA enrolment until set up. */
  enrolmentGrace: boolean;
}

export interface MaintenanceConfig {
  enabled: boolean;
  message: string;
}

export interface BackupConfig {
  enabled: boolean;
  scheduleHours: number;
  retentionCount: number;
  verify: boolean;
}

export interface PrivacyConfig {
  auditRetentionMonths: number;
  securityEventRetentionMonths: number;
}

export interface SecurityConfig {
  blockedIps: string[];
  maxFailedLoginsPerHour: number;
}

export const DEFAULT_SETTINGS = {
  "trial.defaults": {
    defaultDays: 14,
    minDays: 1,
    maxDays: 90,
    graceDays: 7,
    defaultPlanKey: "starter",
    autoExpire: true,
    blockOnExpiry: true,
  } satisfies TrialDefaults,
  "mfa.policy": {
    requiredRoles: ["SUPER_ADMIN"],
    enrolmentGrace: true,
  } satisfies MfaPolicy,
  maintenance: {
    enabled: false,
    message: "StayLoop is undergoing scheduled maintenance. Please check back shortly.",
  } satisfies MaintenanceConfig,
  backup: {
    enabled: false,
    scheduleHours: 24,
    retentionCount: 10,
    verify: true,
  } satisfies BackupConfig,
  privacy: {
    auditRetentionMonths: 24,
    securityEventRetentionMonths: 12,
  } satisfies PrivacyConfig,
  security: {
    blockedIps: [] as string[],
    maxFailedLoginsPerHour: 50,
  } satisfies SecurityConfig,
} as const;
// NOTE: "billing.providers" is owned by src/lib/saas/billing.ts (self-managed
// PlatformSetting row) to keep the module graph acyclic.

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

type SettingValue<K extends SettingKey> = (typeof DEFAULT_SETTINGS)[K];

/** Small in-process cache (5s) so per-request checks stay cheap. */
const CACHE_TTL_MS = 5000;
const cache = new Map<string, { value: unknown; at: number }>();

export function invalidateSettingsCache(): void {
  cache.clear();
}

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value as SettingValue<K>;
  }
  let value: unknown;
  try {
    const row = await db.platformSetting.findUnique({ where: { key } });
    value = row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
  } catch {
    value = DEFAULT_SETTINGS[key];
  }
  // Merge with defaults so newly-introduced fields never break old rows.
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Array.isArray(DEFAULT_SETTINGS[key])
  ) {
    value = {
      ...(DEFAULT_SETTINGS[key] as Record<string, unknown>),
      ...(value as Record<string, unknown>),
    };
  }
  cache.set(key, { value, at: Date.now() });
  return value as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  actor?: { userId?: string; hotelId?: string | null; req?: Request },
): Promise<void> {
  await db.platformSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
  invalidateSettingsCache();
  await logAudit({
    hotelId: actor?.hotelId ?? null,
    userId: actor?.userId,
    action: AUDIT_ACTIONS.PLATFORM_SETTING_CHANGED,
    entityType: "platform_setting",
    entityId: key,
    metadata: { key, value: JSON.parse(JSON.stringify(value)) },
    req: actor?.req,
  });
}

/** Read multiple settings at once. */
export async function getSettings<K extends SettingKey>(
  keys: K[],
): Promise<{ [k in K]: SettingValue<k> }> {
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(k)] as const));
  return Object.fromEntries(entries) as { [k in K]: SettingValue<k> };
}

// ---------- Convenience helpers used by guards ----------

export async function isMaintenanceMode(): Promise<{ enabled: boolean; message: string }> {
  const maintenance = await getSetting("maintenance");
  return { enabled: maintenance.enabled, message: maintenance.message };
}

export async function mfaRequiredForRole(role: string): Promise<boolean> {
  const policy = await getSetting("mfa.policy");
  return policy.requiredRoles.includes(role);
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  const security = await getSetting("security");
  return security.blockedIps.includes(ip);
}
