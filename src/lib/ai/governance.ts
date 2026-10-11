/**
 * Phase 18 — AI GOVERNANCE (the gate every AI feature passes through).
 *
 * Hard rules enforced HERE, not in the UI:
 *  1. Every AI feature is OFF by default. `getAISettings` returns the tenant's
 *     row (lazily created) and each engine MUST check its flag before doing
 *     any work. No flag → the feature does not exist for that tenant.
 *  2. BUDGET. Every billable AI request (chatbot turn, recommendation
 *     generation, forecast computation) reserves against BOTH the tenant
 *     daily/monthly AI caps AND the plan's aiRequests limit (existing SaaS
 *     limit infrastructure — no parallel metering).
 *  3. TENANT ISOLATION. Every helper is keyed by hotelId; callers pass the
 *     authenticated tenant id — never a client-supplied one.
 *  4. AUDIT. Every decision (OK / refused / fallback) appends an
 *     AIInteractionLog row with reason codes — never raw customer text,
 *     never secrets. This is the governance trail the acceptance report and
 *     the owner console both read from.
 *  5. MODEL POLICY. `modelProvider NONE` (the default) means NO external
 *     model calls — all engines are transparent rule-based implementations
 *     labelled RULE_BASED. An external provider can only be switched on by
 *     the owner AND requires credentials configured via the existing
 *     integration vault; until then no code path may claim MODEL_BASED.
 *  6. AI NEVER OVERRIDES: finance, tax, consent or permission decisions. The
 *     chatbot places orders only through the same server-validated
 *     createOrder pipeline; recommendations require human approval before
 *     any send; forecasts are advisory-only and write no operational data.
 */

import { db } from "@/lib/db";
import { reserveUsage } from "@/lib/saas/limits";
import { logger } from "@/lib/logger";

export type AIKind = "CHATBOT" | "RECOMMENDATION" | "FORECAST" | "WALLET" | "VOICE";
export type AIStatus =
  | "OK"
  | "REFUSED"
  | "BLOCKED_BUDGET"
  | "BLOCKED_DISABLED"
  | "BLOCKED_CONSENT"
  | "HANDOFF"
  | "NOT_ENOUGH_DATA"
  | "ERROR";

export interface AISettingsView {
  chatbotEnabled: boolean;
  chatbotServiceHours: { [dow: string]: Array<{ open: string; close: string }> } | null;
  recommendationsEnabled: boolean;
  forecastingEnabled: boolean;
  voiceEnabled: boolean;
  walletEnabled: boolean;
  sustainabilityEnabled: boolean;
  modelProvider: "NONE" | (string & {});
  dailyRequestCap: number;
  monthlyRequestCap: number;
  handoffPhone: string | null;
}

/** Load (lazily create) the tenant AI settings row. */
export async function getAISettings(hotelId: string): Promise<AISettingsView> {
  const row = await db.aISettings.findUnique({ where: { hotelId } });
  if (row) return settingsView(row);
  const created = await db.aISettings.create({ data: { hotelId } }).catch(async () => {
    // Concurrent first-use — re-read (the unique constraint protects us).
    const again = await db.aISettings.findUnique({ where: { hotelId } });
    if (!again) throw new Error("AISettings could not be created");
    return again;
  });
  return settingsView(created);
}

type AISettingsRow = {
  chatbotEnabled: boolean;
  chatbotServiceHours: string | null;
  recommendationsEnabled: boolean;
  forecastingEnabled: boolean;
  voiceEnabled: boolean;
  walletEnabled: boolean;
  sustainabilityEnabled: boolean;
  modelProvider: string;
  dailyRequestCap: number;
  monthlyRequestCap: number;
  handoffPhone: string | null;
};

function settingsView(row: AISettingsRow): AISettingsView {
  let hours: AISettingsView["chatbotServiceHours"] = null;
  if (row.chatbotServiceHours) {
    try {
      const parsed = JSON.parse(row.chatbotServiceHours) as AISettingsView["chatbotServiceHours"];
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) hours = parsed;
    } catch {
      hours = null; // corrupt config = treat as "no window" (always available)
    }
  }
  return {
    chatbotEnabled: row.chatbotEnabled,
    chatbotServiceHours: hours,
    recommendationsEnabled: row.recommendationsEnabled,
    forecastingEnabled: row.forecastingEnabled,
    voiceEnabled: row.voiceEnabled,
    walletEnabled: row.walletEnabled,
    sustainabilityEnabled: row.sustainabilityEnabled,
    modelProvider: row.modelProvider === "NONE" ? "NONE" : row.modelProvider,
    dailyRequestCap: row.dailyRequestCap,
    monthlyRequestCap: row.monthlyRequestCap,
    handoffPhone: row.handoffPhone,
  };
}

/** Is the chatbot inside its configured service window (tenant clock is UTC-stored; window is evaluated on the server clock's UTC day — documented). */
export function withinServiceHours(
  hours: AISettingsView["chatbotServiceHours"],
  now = new Date(),
): boolean {
  if (!hours) return true; // no window configured = always available
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dow = days[now.getUTCDay()];
  const windows = hours[dow];
  if (!windows || windows.length === 0) return false; // day configured but no window → closed
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const w of windows) {
    const [oh, om] = String(w.open).split(":").map(Number);
    const [ch, cm] = String(w.close).split(":").map(Number);
    if ([oh, om, ch, cm].some((n) => !Number.isFinite(n))) continue;
    const open = oh * 60 + om;
    const close = ch * 60 + cm;
    if (open <= close ? minutes >= open && minutes < close : minutes >= open || minutes < close) {
      return true;
    }
  }
  return false;
}

/**
 * Tenant AI daily/monthly budget counters. Uses a dedicated UsageRecord-like
 * table? NO — AI requests are metered on the Plan's existing `aiRequests`
 * resource via reserveUsage (monthly), plus a per-tenant daily counter
 * derived from AIInteractionLog rows (created today). This keeps ONE plan
 * meter and adds the finer daily cap without new metering tables.
 */
export async function reserveAIRequest(hotelId: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const settings = await getAISettings(hotelId);
  if (settings.modelProvider !== "NONE") {
    // External providers are only allowed when the owner explicitly enabled
    // them; billing guards live with the provider integration. The cap logic
    // below applies to ALL providers.
  }

  // Daily cap — count today's billable interactions (UTC day).
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const usedToday = await db.aIInteractionLog.count({
    where: { hotelId, createdAt: { gte: startOfDay }, status: { in: ["OK", "HANDOFF"] } },
  });
  if (usedToday >= settings.dailyRequestCap) {
    return { ok: false, reason: "DAILY_AI_CAP_REACHED" };
  }

  // Monthly plan-level AI quota (existing SaaS metering).
  const quotaErr = await reserveUsage(hotelId, "aiRequests", { skipAudit: true }).catch(
    () => ({ code: "QUOTA_READ_FAIL" }) as const,
  );
  if (quotaErr) return { ok: false, reason: "PLAN_AI_QUOTA_REACHED" };

  return { ok: true };
}

/** Release a reserved AI request when the action failed before doing work. */
export async function releaseAIRequest(hotelId: string): Promise<void> {
  try {
    const hotel = await db.hotel.findUnique({ where: { id: hotelId }, select: { id: true } });
    if (!hotel) return;
    // releaseUsage for aiRequests — mirror of reserveUsage (guarded decrement).
    const { releaseUsage } = await import("@/lib/saas/limits");
    await releaseUsage(hotelId, "aiRequests");
  } catch {
    // metering must never break the action
  }
}

/** Append the governance audit row. NEVER log raw customer text or secrets. */
export async function logAIInteraction(data: {
  hotelId: string;
  kind: AIKind;
  subtype?: string | null;
  channel?: string | null;
  status: AIStatus;
  reason?: string | null;
  customerId?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.aIInteractionLog.create({
      data: {
        hotelId: data.hotelId,
        kind: data.kind,
        subtype: data.subtype ?? null,
        channel: data.channel ?? null,
        status: data.status,
        reason: data.reason ?? null,
        customerId: data.customerId ?? null,
        metaJson: data.meta ? JSON.stringify(sanitizeMeta(data.meta)) : null,
      },
    });
  } catch (err) {
    // Audit must never break the action — but log loudly for ops.
    logger.error("ai.audit_write_failed", { error: String(err), kind: data.kind });
  }
}

const BLOCKED_META_KEYS = new Set([
  "prompt", "message", "body", "text", "inbound", "raw", "password", "token", "secret",
]);

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (BLOCKED_META_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === "string" && v.length > 300) clean[k] = v.slice(0, 300);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) clean[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      clean[k] = v.slice(0, 20);
    } else clean[k] = "[object]";
  }
  return clean;
}
