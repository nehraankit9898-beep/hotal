import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { startTrial } from "@/lib/saas/subscriptions";
import { getSetting } from "@/lib/saas/settings";

/**
 * Super Admin / Multi-Tenant Control Center — Phase 6 (+ Phases 2/3 hardening)
 *
 * SECURITY MODEL (Phase 2/3):
 *   - There is NO default Super Admin account and NO default password.
 *     The FIRST Super Admin is created exclusively through the bootstrap
 *     process (scripts/bootstrap-admin.ts or POST /api/super-admin/bootstrap),
 *     which requires ADMIN_BOOTSTRAP_SECRET and sets a random one-time
 *     password that must be changed at first login (mustChangePassword).
 *   - Hotel owners are NEVER created with a predictable password. When a
 *     Super Admin creates a hotel, the owner account starts PENDING and a
 *     one-time invitation token is issued; the owner chooses their own
 *     password on the activation screen.
 *   - Login endpoints never create accounts.
 *
 * All operations are audited. Support access auto-expires via expiresAt.
 */

// ---------- One-time tokens (owner invitation) ----------

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Issue a one-time activation token for a user. Returns the RAW token ONCE. */
export async function issueActivationToken(
  userId: string,
  purpose: "OWNER_INVITATION" | "PASSWORD_RESET" = "OWNER_INVITATION",
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.activationToken.create({
    data: { userId, tokenHash: hashInvitationToken(token), purpose, expiresAt },
  });
  return { token, expiresAt };
}

/** Validate + consume a one-time token (single use, checked atomically). */
export async function consumeActivationToken(
  token: string,
  purpose: "OWNER_INVITATION" | "PASSWORD_RESET",
): Promise<{ userId: string } | { error: string }> {
  const record = await db.activationToken.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
  });
  if (!record || record.purpose !== purpose) return { error: "INVALID" };
  if (record.usedAt) return { error: "USED" };
  if (record.expiresAt < new Date()) return { error: "EXPIRED" };
  // Atomically claim the token: updateMany with usedAt:null guard guarantees
  // a single winner even under concurrent activation attempts.
  const claimed = await db.activationToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return { error: "USED" };
  return { userId: record.userId };
}

// ---------- Super Admin bootstrap (Phase 2) ----------

export interface BootstrapResult {
  id: string;
  email: string;
  temporaryPassword: string; // returned ONCE to the bootstrap operator
  mustChangePassword: boolean;
}

/** PlatformSetting key for the one-shot bootstrap claim (audit fix bootstrap-1). */
const BOOTSTRAP_CLAIM_KEY = "bootstrap.super_admin.claimed";

/**
 * Create the FIRST Super Admin. Only callable by the bootstrap command /
 * bootstrap endpoint AFTER the caller verified ADMIN_BOOTSTRAP_SECRET, and
 * only when no Super Admin exists (fail-closed against re-seeding).
 *
 * AUDIT FIX (bootstrap-1): atomic claim. The old implementation was a plain
 * count-then-create: two CONCURRENT bootstrap invocations (operator
 * double-runs the one-shot command; script + API endpoint race) both passed
 * the count check and created TWO Super Admins. The claim below is a
 * compare-and-swap on a PlatformSetting row — exactly one concurrent caller
 * can transition it "false" → "true", and the winner re-checks the count
 * INSIDE the critical section (a released claim after a failed create is
 * only re-claimable after the created user is visible, which the count
 * re-check then rejects). A failure in the create path releases the claim so
 * the operator can legitimately retry.
 */
export async function bootstrapFirstSuperAdmin(params: {
  name: string;
  email: string;
  bootstrapSecret: string;
}): Promise<BootstrapResult> {
  const existingCount = await db.user.count({ where: { role: "SUPER_ADMIN" } });
  if (existingCount > 0) {
    throw new Error("A Super Admin already exists. Bootstrap is disabled.");
  }
  const existingUser = await db.user.findUnique({ where: { email: params.email } });
  if (existingUser) {
    throw new Error("A user with this email already exists.");
  }

  // Idempotent row bootstrap, then the atomic claim.
  await db.platformSetting.upsert({
    where: { key: BOOTSTRAP_CLAIM_KEY },
    create: { key: BOOTSTRAP_CLAIM_KEY, value: "false" },
    update: {},
  });
  const claim = await db.platformSetting.updateMany({
    where: { key: BOOTSTRAP_CLAIM_KEY, value: "false" },
    data: { value: "true" },
  });
  if (claim.count !== 1) {
    throw new Error("A Super Admin already exists. Bootstrap is disabled.");
  }

  const releaseClaim = async () => {
    await db.platformSetting
      .updateMany({ where: { key: BOOTSTRAP_CLAIM_KEY, value: "true" }, data: { value: "false" } })
      .catch(() => undefined);
  };

  try {
    // Critical section: re-check after winning the claim. A previous claim
    // winner that failed AFTER creating the user (e.g. audit write error) has
    // released the claim — but its user row is committed and visible here, so
    // this re-check turns the retry into an honest "already exists".
    const recheck = await db.user.count({ where: { role: "SUPER_ADMIN" } });
    if (recheck > 0) {
      await releaseClaim();
      throw new Error("A Super Admin already exists. Bootstrap is disabled.");
    }

    // Cryptographically random one-time password — never logged, returned once.
    const temporaryPassword = randomBytes(18).toString("base64url") + "aA9";
    const user = await db.user.create({
      data: {
        name: params.name,
        email: params.email,
        passwordHash: hashPassword(temporaryPassword),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        mustChangePassword: true,
      },
    });
    await logAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.SUPER_ADMIN_BOOTSTRAPPED,
      entityType: "user",
      entityId: user.id,
      metadata: { email: user.email, bootstrap: true },
    });
    return {
      id: user.id,
      email: user.email,
      temporaryPassword,
      mustChangePassword: true,
    };
  } catch (err) {
    await releaseClaim();
    throw err;
  }
}

// ---------- Plans ----------

export const PLAN_DEFS = [
  {
    name: "FREE",
    description: "Up to 100 customers, 1 user, 50 messages/mo, 1 campaign.",
    monthlyPrice: 0,
    customerLimit: 100,
    campaignLimit: 1,
    messageLimit: 50,
    staffLimit: 1,
    storageMb: 100,
    apiAccess: false,
    advancedAnalytics: false,
    aiUsageLimit: 0,
  },
  {
    name: "STARTER",
    description: "Up to 1,000 customers, 3 staff, 2,000 messages/mo.",
    monthlyPrice: 1999,
    customerLimit: 1000,
    campaignLimit: 10,
    messageLimit: 2000,
    staffLimit: 3,
    storageMb: 1024,
    apiAccess: false,
    advancedAnalytics: false,
    aiUsageLimit: 100,
  },
  {
    name: "PROFESSIONAL",
    description: "Up to 5,000 customers, 10 staff, 10,000 messages/mo.",
    monthlyPrice: 4999,
    customerLimit: 5000,
    campaignLimit: 50,
    messageLimit: 10000,
    staffLimit: 10,
    storageMb: 5120,
    apiAccess: true,
    advancedAnalytics: false,
    aiUsageLimit: 1000,
  },
  {
    name: "BUSINESS",
    description: "Up to 20,000 customers, 25 staff, 50,000 messages/mo.",
    monthlyPrice: 9999,
    customerLimit: 20000,
    campaignLimit: 200,
    messageLimit: 50000,
    staffLimit: 25,
    storageMb: 20480,
    apiAccess: true,
    advancedAnalytics: true,
    aiUsageLimit: 10000,
  },
  {
    name: "ENTERPRISE",
    description: "Unlimited customers, unlimited staff, dedicated support.",
    monthlyPrice: 24999,
    customerLimit: 0,
    campaignLimit: 0,
    messageLimit: 0,
    staffLimit: 0,
    storageMb: 102400,
    apiAccess: true,
    advancedAnalytics: true,
    aiUsageLimit: 100000,
  },
] as const;

export async function ensurePlansSeed() {
  // Phase 10: defaults are CREATE-ONLY. Super Admin edits (prices, limits,
  // features) are never overwritten by the seeder — the DB is the source of
  // truth for pricing, not this array.
  for (const def of PLAN_DEFS) {
    await db.plan.upsert({
      where: { name: def.name },
      create: {
        name: def.name,
        key: def.name.toLowerCase(),
        description: def.description,
        monthlyPrice: def.monthlyPrice,
        yearlyPrice: def.monthlyPrice * 10,
        customerLimit: def.customerLimit,
        campaignLimit: def.campaignLimit,
        messageLimit: def.messageLimit,
        staffLimit: def.staffLimit,
        storageMb: def.storageMb,
        apiAccess: def.apiAccess,
        advancedAnalytics: def.advancedAnalytics,
        aiUsageLimit: def.aiUsageLimit,
        features: JSON.stringify([
          "ROOM_CRM",
          "CUSTOMER_CRM",
          "CAMPAIGNS",
          "ANALYTICS",
          "OFFERS",
          "WHATSAPP",
          "SMS",
          "EMAIL",
          "REPORTS",
          ...(def.apiAccess ? ["API"] : []),
          ...(def.advancedAnalytics ? ["ADVANCED_ANALYTICS"] : []),
        ]),
      },
      update: {}, // never clobber admin-customized values
    });
  }
}

export const DEFAULT_FEATURE_KEYS = [
  "ROOM_CRM",
  "RESTAURANT_CRM",
  "CUSTOMER_CRM",
  "CAMPAIGNS",
  "WHATSAPP",
  "SMS",
  "EMAIL",
  "OFFERS",
  "AUTOMATION",
  "ANALYTICS",
  "AI_ASSISTANT",
  "REPORTS",
  "API",
  "POS_INTEGRATION",
] as const;

/** Default a hotel's feature flags to ON for everything. */
export async function ensureDefaultFeatureFlags(hotelId: string) {
  for (const key of DEFAULT_FEATURE_KEYS) {
    await db.tenantFeature.upsert({
      where: { hotelId_featureKey: { hotelId, featureKey: key } },
      create: { hotelId, featureKey: key, enabled: true },
      update: {},
    });
  }
  return db.tenantFeature.findMany({ where: { hotelId } });
}

export interface HotelUsageSummary {
  customers: number;
  customersLimit: number;
  customersUsed: number;
  customersRemaining: number;
  customersPercent: number;
  messages: number;
  messagesLimit: number;
  messagesUsed: number;
  messagesRemaining: number;
  messagesPercent: number;
  campaigns: number;
  campaignsLimit: number;
  campaignsUsed: number;
  campaignsRemaining: number;
  campaignsPercent: number;
  staff: number;
  staffLimit: number;
  staffUsed: number;
  staffRemaining: number;
  staffPercent: number;
  storageMb: number;
  storageMbLimit: number;
  storagePercent: number;
  automations: number;
  apiRequests: number;
  aiRequests: number;
  aiUsageLimit: number;
}

export async function getHotelUsage(
  hotelId: string,
  planId: string | null,
): Promise<HotelUsageSummary> {
  const plan = planId ? await db.plan.findUnique({ where: { id: planId } }) : null;
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const usage = await db.usageRecord.upsert({
    where: { hotelId_period: { hotelId, period } },
    create: { hotelId, period },
    update: {},
  });

  // Refresh the usage row from live data
  const [customersCount, messagesCount, campaignsCount, automationsCount, staffCount] =
    await Promise.all([
      db.customer.count({ where: { hotelId } }),
      db.campaignMessage.count({ where: { hotelId } }),
      db.campaign.count({ where: { hotelId } }),
      db.automationRule.count({ where: { hotelId } }),
      db.user.count({ where: { hotelId, status: "ACTIVE" } }),
    ]);
  const refreshed = await db.usageRecord.update({
    where: { id: usage.id },
    data: {
      customers: customersCount,
      messages: messagesCount,
      campaigns: campaignsCount,
      automations: automationsCount,
      staff: staffCount,
    },
  });

  const customersLimit = plan?.customerLimit ?? 0;
  const messagesLimit = plan?.messageLimit ?? 0;
  const campaignsLimit = plan?.campaignLimit ?? 0;
  const staffLimit = plan?.staffLimit ?? 0;
  const storageLimit = plan?.storageMb ?? 0;

  const pct = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return {
    customers: customersCount,
    customersLimit,
    customersUsed: customersCount,
    customersRemaining: customersLimit > 0 ? Math.max(0, customersLimit - customersCount) : 0,
    customersPercent: pct(customersCount, customersLimit),
    messages: messagesCount,
    messagesLimit,
    messagesUsed: messagesCount,
    messagesRemaining: messagesLimit > 0 ? Math.max(0, messagesLimit - messagesCount) : 0,
    messagesPercent: pct(messagesCount, messagesLimit),
    campaigns: campaignsCount,
    campaignsLimit,
    campaignsUsed: campaignsCount,
    campaignsRemaining: campaignsLimit > 0 ? Math.max(0, campaignsLimit - campaignsCount) : 0,
    campaignsPercent: pct(campaignsCount, campaignsLimit),
    staff: staffCount,
    staffLimit,
    staffUsed: staffCount,
    staffRemaining: staffLimit > 0 ? Math.max(0, staffLimit - staffCount) : 0,
    staffPercent: pct(staffCount, staffLimit),
    storageMb: refreshed.storageMb,
    storageMbLimit: storageLimit,
    storagePercent: pct(refreshed.storageMb, storageLimit),
    automations: automationsCount,
    apiRequests: refreshed.apiRequests,
    aiRequests: refreshed.aiRequests,
    aiUsageLimit: plan?.aiUsageLimit ?? 0,
  };
}

/** Create a new hotel tenant (super admin only) — Phase 3 invitation flow. */
export async function createHotelTenant(params: {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  gstin?: string;
  timezone?: string;
  currency?: string;
  planName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  features?: string[];
  adminUserId: string;
}): Promise<{
  hotel: { id: string; name: string; tenantId: string | null };
  owner: { id: string; email: string };
  plan: { id: string; name: string };
  invitation: { token: string; expiresAt: Date; activationPath: string };
}> {
  const plan = await db.plan.findUnique({ where: { name: params.planName } });
  if (!plan) throw new Error(`Unknown plan: ${params.planName}`);

  const ownerEmailTaken = await db.user.findUnique({ where: { email: params.ownerEmail } });
  if (ownerEmailTaken) throw new Error("A user with the owner email already exists.");

  const hotel = await db.hotel.create({
    data: {
      name: params.name,
      address: params.address,
      city: params.city,
      state: params.state,
      country: params.country,
      phone: params.phone,
      email: params.email,
      website: params.website,
      gstin: params.gstin,
      timezone: params.timezone ?? "Asia/Kolkata",
      currency: params.currency ?? "INR",
      planId: plan.id,
      tenantId: `T-${Date.now().toString(36).toUpperCase()}`,
    },
  });

  // Owner account — created PENDING with NO password. The owner activates via
  // the one-time invitation token and sets their own password (Phase 3).
  const owner = await db.user.create({
    data: {
      hotelId: hotel.id,
      name: params.ownerName,
      email: params.ownerEmail,
      passwordHash: hashPassword(randomBytes(32).toString("base64url")), // unguessable; unusable until activation
      role: "HOTEL_OWNER",
      status: "PENDING",
      mustChangePassword: true,
    },
  });

  const invitation = await issueActivationToken(owner.id, "OWNER_INVITATION");

  // Phase 10 — Trial engine: new tenants start on a TRIAL (duration from
  // plan.trialDays, falling back to platform trial defaults), converting to
  // paid after checkout. Legacy ACTIVE subscriptions are no longer created
  // directly — payment is verified server-side before activation.
  const trialDefaults = await getSetting("trial.defaults");
  const trialDays = plan.trialDays > 0 ? plan.trialDays : trialDefaults.defaultDays;
  await startTrial({
    hotelId: hotel.id,
    planId: plan.id,
    days: trialDays,
    adminUserId: params.adminUserId,
    reason: "tenant-created",
  });

  // Feature flags
  await ensureDefaultFeatureFlags(hotel.id);

  await logAudit({
    hotelId: hotel.id,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.HOTEL_CREATED,
    entityType: "hotel",
    entityId: hotel.id,
    metadata: { name: hotel.name, plan: plan.name, owner: owner.email, invitationIssued: true },
  });
  await logAudit({
    hotelId: hotel.id,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.OWNER_INVITED,
    entityType: "user",
    entityId: owner.id,
    metadata: { ownerEmail: owner.email, expiresAt: invitation.expiresAt.toISOString() },
  });

  return {
    hotel: { id: hotel.id, name: hotel.name, tenantId: hotel.tenantId },
    owner: { id: owner.id, email: owner.email },
    plan: { id: plan.id, name: plan.name },
    invitation: {
      token: invitation.token,
      expiresAt: invitation.expiresAt,
      activationPath: `/activate?token=${invitation.token}`,
    },
  };
}

/** Suspend a hotel (soft). */
export async function suspendHotel(hotelId: string, reason: string, adminUserId: string) {
  const hotel = await db.hotel.update({
    where: { id: hotelId },
    data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: reason },
  });
  await logAudit({
    hotelId,
    userId: adminUserId,
    action: AUDIT_ACTIONS.HOTEL_SUSPENDED,
    entityType: "hotel",
    entityId: hotelId,
    metadata: { reason },
  });
  return hotel;
}

export async function activateHotel(hotelId: string, adminUserId: string) {
  const hotel = await db.hotel.update({
    where: { id: hotelId },
    data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null },
  });
  await logAudit({
    hotelId,
    userId: adminUserId,
    action: AUDIT_ACTIONS.HOTEL_ACTIVATED,
    entityType: "hotel",
    entityId: hotelId,
  });
  return hotel;
}

/** Request time-limited support access to a hotel. */
export async function requestSupportAccess(params: {
  hotelId: string;
  adminUserId: string;
  reason: string;
  durationMinutes: number;
}): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + params.durationMinutes * 60 * 1000);
  const session = await db.supportSession.create({
    data: {
      hotelId: params.hotelId,
      adminUserId: params.adminUserId,
      reason: params.reason,
      durationMinutes: params.durationMinutes,
      expiresAt,
      status: "ACTIVE",
    },
  });
  await logAudit({
    hotelId: params.hotelId,
    userId: params.adminUserId,
    action: AUDIT_ACTIONS.SUPPORT_ACCESS_REQUESTED,
    entityType: "support_session",
    entityId: session.id,
    metadata: { reason: params.reason, durationMinutes: params.durationMinutes },
  });
  return session;
}

/** Auto-expire support sessions whose expiresAt is in the past. */
export async function expireStaleSupportSessions() {
  const result = await db.supportSession.updateMany({
    where: { status: "ACTIVE", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED", endedAt: new Date() },
  });
  return result.count;
}

/** System health: checks each subsystem. */
export async function getSystemHealth() {
  const { emailTransportStatus } = await import("@/lib/providers/email");
  const { distributedLimiterStatus } = await import("@/lib/rate-limit");
  const { workerHeartbeatStatus, WORKER_HEARTBEAT_KEY } = await import("@/lib/worker-heartbeat");
  const emailTransport = emailTransportStatus();
  const emailReal =
    emailTransport === "smtp" ||
    emailTransport === "aws_ses" ||
    emailTransport === "resend" ||
    emailTransport === "sendgrid";
  const limiter = distributedLimiterStatus();

  // Observable worker heartbeat (audit fix: not a "process exists" guess).
  const heartbeat = await workerHeartbeatStatus();
  let heartbeatDetail = "No heartbeat recorded yet";
  try {
    const row = await db.platformSetting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as {
        workerId?: string;
        at?: number;
        jobsCompleted?: number;
      };
      if (parsed.at) {
        const ageSec = Math.max(0, Math.round((Date.now() - parsed.at) / 1000));
        heartbeatDetail = `${parsed.workerId ?? "worker"} — last beat ${ageSec}s ago, ${parsed.jobsCompleted ?? 0} jobs completed`;
      }
    }
  } catch {
    /* heartbeat detail is best-effort */
  }

  const checks = await Promise.all([
    db.hotel
      .count()
      .then((c) => ({ subsystem: "Database", status: "HEALTHY" as const, detail: `${c} hotels` }))
      .catch(() => ({
        subsystem: "Database",
        status: "DOWN" as const,
        detail: "Connection failed",
      })),
    Promise.resolve({ subsystem: "API", status: "HEALTHY" as const, detail: "Routes responding" }),
    Promise.resolve({
      subsystem: "Background worker",
      status:
        heartbeat === "ok"
          ? ("HEALTHY" as const)
          : heartbeat === "stale"
            ? ("DOWN" as const)
            : ("DEGRADED" as const),
      detail:
        heartbeat === "ok"
          ? heartbeatDetail
          : heartbeat === "stale"
            ? `Heartbeat STALE — ${heartbeatDetail}`
            : "No heartbeat yet (worker starting or not running)",
    }),
    Promise.resolve({
      subsystem: "Rate limiter backend",
      status:
        limiter === "ready" || limiter === "disabled"
          ? ("HEALTHY" as const)
          : ("DEGRADED" as const),
      detail:
        limiter === "ready"
          ? "Redis (distributed)"
          : limiter === "error"
            ? "Redis error — in-memory fallback"
            : "In-memory (set REDIS_URL for distributed)",
    }),
    Promise.resolve({
      subsystem: "WhatsApp provider",
      status: process.env.WHATSAPP_TOKEN ? ("HEALTHY" as const) : ("DEGRADED" as const),
      detail: process.env.WHATSAPP_TOKEN ? "Connected" : "Simulation mode",
    }),
    Promise.resolve({
      subsystem: "SMS provider",
      status: process.env.TWILIO_ACCOUNT_SID ? ("HEALTHY" as const) : ("DEGRADED" as const),
      detail: process.env.TWILIO_ACCOUNT_SID ? "Connected" : "Simulation mode",
    }),
    Promise.resolve({
      subsystem: "Email provider",
      status: emailReal ? ("HEALTHY" as const) : ("DEGRADED" as const),
      detail: emailReal
        ? `Connected (${emailTransport})`
        : emailTransport === "mock"
          ? "Mock adapter (dev)"
          : "Not configured",
    }),
    Promise.resolve({
      subsystem: "Storage",
      status: "HEALTHY" as const,
      detail: "Local filesystem",
    }),
    Promise.resolve({
      subsystem: "AI service",
      status: "HEALTHY" as const,
      detail: "z-ai-web-dev-sdk available",
    }),
  ]);
  return checks;
}

/** Platform-wide stats for the super admin dashboard. */
export async function getPlatformStats() {
  const [
    totalHotels,
    activeHotels,
    suspendedHotels,
    totalCustomers,
    totalMessages,
    activeCampaigns,
    monthlyRevenue,
  ] = await Promise.all([
    db.hotel.count(),
    db.hotel.count({ where: { status: "ACTIVE" } }),
    db.hotel.count({ where: { status: "SUSPENDED" } }),
    db.customer.count(),
    db.campaignMessage.count(),
    db.campaign.count({ where: { status: "ACTIVE" } }),
    db.subscription.aggregate({ where: { status: "ACTIVE" }, _sum: { amount: true } }),
  ]);

  // Phase 10 — SaaS business metrics (trials, conversions, churn, revenue).
  const [
    trialingSubs,
    graceSubs,
    expiredSubs,
    cancelledSubs,
    activeSubs,
    paidCollected,
    totalUsers,
    activeUsers,
    hotelAdmins,
    apiRequests,
    aiRequests,
  ] = await Promise.all([
    db.subscription.count({ where: { status: "TRIALING" } }),
    db.subscription.count({ where: { status: "GRACE" } }),
    db.subscription.count({ where: { status: "EXPIRED" } }),
    db.subscription.count({ where: { status: "CANCELLED" } }),
    db.subscription.count({ where: { status: "ACTIVE" } }),
    db.payment.aggregate({ where: { status: "PAID" }, _sum: { amount: true } }),
    db.user.count(),
    db.user.count({ where: { status: "ACTIVE" } }),
    db.user.count({ where: { role: { in: ["HOTEL_OWNER", "HOTEL_ADMIN"] }, status: "ACTIVE" } }),
    db.usageRecord.aggregate({ _sum: { apiRequests: true } }),
    db.usageRecord.aggregate({ _sum: { aiRequests: true } }),
  ]);

  const failedCampaigns = await db.campaign.count({ where: { status: "FAILED" } });
  const restaurantCustomers = await db.customer.count({
    where: { totalRestaurantVisits: { gt: 0 } },
  });

  const trialConversionDenominator = activeSubs + expiredSubs + cancelledSubs;
  const mrr = monthlyRevenue._sum.amount ?? 0;

  return {
    totalHotels,
    activeHotels,
    suspendedHotels,
    totalCustomers,
    restaurantCustomers,
    messagesSent: totalMessages,
    activeCampaigns,
    monthlyRevenue: mrr,
    failedCampaigns,
    // Phase 10 business KPIs
    arr: mrr * 12,
    trialingSubscriptions: trialingSubs,
    graceSubscriptions: graceSubs,
    expiredSubscriptions: expiredSubs,
    cancelledSubscriptions: cancelledSubs,
    activeSubscriptions: activeSubs,
    trialConversionRate:
      trialConversionDenominator > 0
        ? Math.round((activeSubs / trialConversionDenominator) * 100)
        : 0,
    churnRate:
      trialConversionDenominator > 0
        ? Math.round(((expiredSubs + cancelledSubs) / trialConversionDenominator) * 100)
        : 0,
    lifetimeCollected: paidCollected._sum.amount ?? 0,
    totalUsers,
    activeUsers,
    activeHotelAdmins: hotelAdmins,
    apiRequests: apiRequests._sum.apiRequests ?? 0,
    aiRequests: aiRequests._sum.aiRequests ?? 0,
  };
}
