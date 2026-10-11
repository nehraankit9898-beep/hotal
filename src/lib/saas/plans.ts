import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Plan management — Phase 10 §2/§3.
 *
 * Plans, pricing, feature entitlements and limits live ONLY in the database.
 * The public pricing endpoint (/api/pricing) and every limit/entitlement
 * check read from here. Super Admin creates/edits/archives plans through
 * /api/super-admin/plans — never a hardcoded PLAN_DEFS array.
 */

export interface PlanFeatures {
  features: string[];
}

export function parsePlanFeatures(featuresJson: string | null): string[] | null {
  if (!featuresJson) return null;
  try {
    const parsed = JSON.parse(featuresJson);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : null;
  } catch {
    return null;
  }
}

/** Public shape of a plan (safe for the pricing page — no secrets involved). */
export interface PublicPlan {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  setupFee: number;
  trialDays: number;
  graceDays: number;
  recommended: boolean;
  sortOrder: number;
  features: string[];
  limits: {
    customers: number;
    campaigns: number;
    messages: number;
    staff: number;
    aiRequests: number;
    storageMb: number;
    apiRequests: number;
    exports: number;
    locations: number;
    restaurants: number;
    whatsappMessages: number;
    smsMessages: number;
    apiAccess: boolean;
    advancedAnalytics: boolean;
  };
}

export function toPublicPlan(plan: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  setupFee: number;
  trialDays: number;
  graceDays: number;
  recommended: boolean;
  sortOrder: number;
  features: string | null;
  customerLimit: number;
  campaignLimit: number;
  messageLimit: number;
  staffLimit: number;
  aiUsageLimit: number;
  storageMb: number;
  apiRequestLimit: number;
  exportsLimit: number;
  locationsLimit: number;
  restaurantsLimit: number;
  whatsappMessageLimit: number;
  smsMessageLimit: number;
  apiAccess: boolean;
  advancedAnalytics: boolean;
}): PublicPlan {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    monthlyPrice: plan.monthlyPrice,
    yearlyPrice: plan.yearlyPrice,
    currency: plan.currency,
    setupFee: plan.setupFee,
    trialDays: plan.trialDays,
    graceDays: plan.graceDays,
    recommended: plan.recommended,
    sortOrder: plan.sortOrder,
    features: parsePlanFeatures(plan.features) ?? [],
    limits: {
      customers: plan.customerLimit,
      campaigns: plan.campaignLimit,
      messages: plan.messageLimit,
      staff: plan.staffLimit,
      aiRequests: plan.aiUsageLimit,
      storageMb: plan.storageMb,
      apiRequests: plan.apiRequestLimit,
      exports: plan.exportsLimit,
      locations: plan.locationsLimit,
      restaurants: plan.restaurantsLimit,
      whatsappMessages: plan.whatsappMessageLimit,
      smsMessages: plan.smsMessageLimit,
      apiAccess: plan.apiAccess,
      advancedAnalytics: plan.advancedAnalytics,
    },
  };
}

/** Active, non-archived, public plans for the pricing page. */
export async function listPublicPlans(): Promise<PublicPlan[]> {
  const plans = await db.plan.findMany({
    where: { isActive: true, isArchived: false, isPublic: true },
    orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
  });
  return plans.map(toPublicPlan);
}

/** All plans for the Super Admin console (incl. private + archived). */
export async function listAllPlans() {
  const plans = await db.plan.findMany({
    where: {},
    orderBy: [{ isArchived: "asc" }, { sortOrder: "asc" }, { monthlyPrice: "asc" }],
    include: { _count: { select: { hotels: true, subscriptions: true } } },
  });
  return plans.map((p) => ({
    ...toPublicPlan(p),
    isActive: p.isActive,
    isArchived: p.isArchived,
    isPublic: p.isPublic,
    createdAt: p.createdAt,
    usage: { hotels: p._count.hotels, subscriptions: p._count.subscriptions },
  }));
}

export interface PlanInput {
  name: string;
  key: string;
  description?: string | null;
  monthlyPrice: number;
  yearlyPrice?: number;
  currency?: string;
  setupFee?: number;
  trialDays?: number;
  graceDays?: number;
  isActive?: boolean;
  isPublic?: boolean;
  recommended?: boolean;
  sortOrder?: number;
  features?: string[];
  customerLimit?: number;
  campaignLimit?: number;
  messageLimit?: number;
  staffLimit?: number;
  aiUsageLimit?: number;
  storageMb?: number;
  apiRequestLimit?: number;
  exportsLimit?: number;
  locationsLimit?: number;
  restaurantsLimit?: number;
  whatsappMessageLimit?: number;
  smsMessageLimit?: number;
  apiAccess?: boolean;
  advancedAnalytics?: boolean;
}

const PLAN_LIMIT_FIELDS = [
  "customerLimit",
  "campaignLimit",
  "messageLimit",
  "staffLimit",
  "aiUsageLimit",
  "storageMb",
  "apiRequestLimit",
  "exportsLimit",
  "locationsLimit",
  "restaurantsLimit",
  "whatsappMessageLimit",
  "smsMessageLimit",
] as const;

export function validatePlanInput(input: Partial<PlanInput>, partial = false): string | null {
  if (typeof input.name !== "string" || !input.name.trim()) {
    if (!partial || input.name !== undefined) return "Plan name is required.";
  }
  if (typeof input.name === "string" && input.name.length > 80)
    return "Plan name must be at most 80 characters.";
  if (typeof input.key === "string" && !/^[a-z0-9_-]{2,40}$/i.test(input.key)) {
    return "Plan key must be 2-40 characters (letters, numbers, - or _).";
  }
  if (
    input.monthlyPrice !== undefined &&
    (typeof input.monthlyPrice !== "number" ||
      input.monthlyPrice < 0 ||
      input.monthlyPrice > 10_000_000)
  ) {
    return "Monthly price must be a non-negative number.";
  }
  if (
    input.yearlyPrice !== undefined &&
    (input.yearlyPrice < 0 || input.yearlyPrice > 100_000_000)
  ) {
    return "Yearly price must be non-negative.";
  }
  if (input.setupFee !== undefined && (input.setupFee < 0 || input.setupFee > 10_000_000)) {
    return "Setup fee must be non-negative.";
  }
  if (input.trialDays !== undefined && (input.trialDays < 0 || input.trialDays > 365)) {
    return "Trial days must be between 0 and 365.";
  }
  if (input.graceDays !== undefined && (input.graceDays < 0 || input.graceDays > 90)) {
    return "Grace days must be between 0 and 90.";
  }
  for (const field of PLAN_LIMIT_FIELDS) {
    const v = input[field];
    if (
      v !== undefined &&
      (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000_000)
    ) {
      return `Invalid value for ${field}.`;
    }
  }
  if (input.features !== undefined) {
    if (
      !Array.isArray(input.features) ||
      input.features.some((f) => typeof f !== "string" || f.length > 60)
    ) {
      return "Features must be a list of keys.";
    }
  }
  return null;
}

/** Create a plan (Super Admin). Prices stored in DB, never in code. */
export async function createPlan(input: PlanInput, adminUserId: string) {
  const key = (
    input.key ??
    input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
  ).slice(0, 40);
  const dupKey = await db.plan.findUnique({ where: { key } });
  if (dupKey) throw new Error("A plan with this key already exists.");
  const dupName = await db.plan.findUnique({ where: { name: input.name.trim() } });
  if (dupName) throw new Error("A plan with this name already exists.");
  const plan = await db.plan.create({
    data: {
      name: input.name.trim(),
      key,
      description: input.description ?? null,
      monthlyPrice: input.monthlyPrice ?? 0,
      yearlyPrice: input.yearlyPrice ?? (input.monthlyPrice ?? 0) * 10,
      currency: input.currency ?? "INR",
      setupFee: input.setupFee ?? 0,
      trialDays: input.trialDays ?? 0,
      graceDays: input.graceDays ?? 0,
      isActive: input.isActive ?? true,
      isPublic: input.isPublic ?? true,
      recommended: input.recommended ?? false,
      sortOrder: input.sortOrder ?? 0,
      features: input.features ? JSON.stringify(input.features) : null,
      customerLimit: input.customerLimit ?? 0,
      campaignLimit: input.campaignLimit ?? 0,
      messageLimit: input.messageLimit ?? 0,
      staffLimit: input.staffLimit ?? 0,
      aiUsageLimit: input.aiUsageLimit ?? 0,
      storageMb: input.storageMb ?? 100,
      apiRequestLimit: input.apiRequestLimit ?? 0,
      exportsLimit: input.exportsLimit ?? 0,
      locationsLimit: input.locationsLimit ?? 0,
      restaurantsLimit: input.restaurantsLimit ?? 0,
      whatsappMessageLimit: input.whatsappMessageLimit ?? 0,
      smsMessageLimit: input.smsMessageLimit ?? 0,
      apiAccess: input.apiAccess ?? false,
      advancedAnalytics: input.advancedAnalytics ?? false,
    },
  });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.PLAN_CREATED,
    entityType: "plan",
    entityId: plan.id,
    metadata: {
      name: plan.name,
      key: plan.key,
      monthlyPrice: plan.monthlyPrice,
      yearlyPrice: plan.yearlyPrice,
    },
  });
  return plan;
}

/** Update a plan (Super Admin). Price changes create PRICE_CHANGED audits. */
export async function updatePlan(planId: string, input: Partial<PlanInput>, adminUserId: string) {
  const existing = await db.plan.findUnique({ where: { id: planId } });
  if (!existing) throw new Error("Plan not found.");
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.monthlyPrice !== undefined) data.monthlyPrice = input.monthlyPrice;
  if (input.yearlyPrice !== undefined) data.yearlyPrice = input.yearlyPrice;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.setupFee !== undefined) data.setupFee = input.setupFee;
  if (input.trialDays !== undefined) data.trialDays = input.trialDays;
  if (input.graceDays !== undefined) data.graceDays = input.graceDays;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.isPublic !== undefined) data.isPublic = input.isPublic;
  if (input.recommended !== undefined) data.recommended = input.recommended;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.features !== undefined)
    data.features = input.features ? JSON.stringify(input.features) : null;
  for (const field of PLAN_LIMIT_FIELDS) {
    if (input[field] !== undefined) data[field] = input[field];
  }
  if (input.apiAccess !== undefined) data.apiAccess = input.apiAccess;
  if (input.advancedAnalytics !== undefined) data.advancedAnalytics = input.advancedAnalytics;
  const plan = await db.plan.update({ where: { id: planId }, data });
  const priceChanged =
    (input.monthlyPrice !== undefined && input.monthlyPrice !== existing.monthlyPrice) ||
    (input.yearlyPrice !== undefined && input.yearlyPrice !== existing.yearlyPrice);
  await logAudit({
    userId: adminUserId,
    action: priceChanged ? AUDIT_ACTIONS.PRICE_CHANGED : AUDIT_ACTIONS.PLAN_UPDATED,
    entityType: "plan",
    entityId: plan.id,
    metadata: priceChanged
      ? {
          before: { monthlyPrice: existing.monthlyPrice, yearlyPrice: existing.yearlyPrice },
          after: { monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice },
        }
      : { name: plan.name },
  });
  return plan;
}

/**
 * Archive a plan instead of deleting when hotels/subscriptions depend on it.
 * Hard delete is only allowed when nothing references the plan.
 */
export async function archivePlan(
  planId: string,
  adminUserId: string,
): Promise<{ archived: boolean; deleted: boolean }> {
  const existing = await db.plan.findUnique({
    where: { id: planId },
    include: { _count: { select: { hotels: true, subscriptions: true } } },
  });
  if (!existing) throw new Error("Plan not found.");
  const inUse = existing._count.hotels > 0 || existing._count.subscriptions > 0;
  if (inUse) {
    await db.plan.update({
      where: { id: planId },
      data: { isArchived: true, isActive: false },
    });
    await logAudit({
      userId: adminUserId,
      action: AUDIT_ACTIONS.PLAN_ARCHIVED,
      entityType: "plan",
      entityId: planId,
      metadata: {
        reason: "Active dependencies — archived instead of deleted",
        hotels: existing._count.hotels,
      },
    });
    return { archived: true, deleted: false };
  }
  await db.plan.delete({ where: { id: planId } });
  await logAudit({
    userId: adminUserId,
    action: AUDIT_ACTIONS.PLAN_ARCHIVED,
    entityType: "plan",
    entityId: planId,
    metadata: { deleted: true },
  });
  return { archived: false, deleted: true };
}
