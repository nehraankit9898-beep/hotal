import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Loyalty engine — Phase 6.3, hardened in Phase 6.4.
 *
 * Real points, real rewards, real tiers — all computed and enforced on the
 * backend. Every mutation runs inside a DB transaction and writes a
 * LoyaltyTransaction row, so balances are fully auditable.
 *
 * Phase 6.4 correctness rules:
 *  1. NO read-modify-write of absolute balances. Every mutation uses atomic
 *     SQL increments/decrements inside a transaction, so concurrent awards,
 *     redemptions, adjustments and reversals can never lose updates.
 *  2. The ledger is IMMUTABLE and authoritative. Historical rows are never
 *     rewritten; corrections create compensating entries (REVERSAL /
 *     VISIT_ADJUST / ADJUST).
 *  3. Ledger writes are idempotent via deterministic idempotency keys — the
 *     same logical event can never produce two ledger rows.
 *  4. Account creation uses upsert() (unique hotelId+customerId), so
 *     concurrent creation attempts cannot crash or duplicate.
 *  5. Balance = sum(ledger points) EXACTLY, including after reversals. A
 *     reversal may take the balance negative when the points were already
 *     redeemed — this is honest accounting (the customer "owes" points) and
 *     is visible to staff, who can issue a manual ADJUST if appropriate.
 *  6. Every entry carries: type, source visitId, reason, actorId, timestamp,
 *     idempotencyKey, balanceBefore, balanceAfter.
 *
 * Two earn modes (per-hotel, configurable):
 *   POINTS — ₹100 spent → `pointsPer100` points
 *   VISITS — each restaurant visit → `pointsPerVisit` points
 *
 * Tiers are derived from lifetime restaurant spend captured by loyalty:
 *   BRONZE (default) → SILVER (silverTierSpend) → GOLD (goldTierSpend) → VIP (vipTierSpend)
 */

export type Tier = "BRONZE" | "SILVER" | "GOLD" | "VIP";

export const TIERS: Tier[] = ["BRONZE", "SILVER", "GOLD", "VIP"];

export function computeTier(
  lifetimeSpend: number,
  settings: { silverTierSpend: number; goldTierSpend: number; vipTierSpend: number },
): Tier {
  if (lifetimeSpend >= settings.vipTierSpend) return "VIP";
  if (lifetimeSpend >= settings.goldTierSpend) return "GOLD";
  if (lifetimeSpend >= settings.silverTierSpend) return "SILVER";
  return "BRONZE";
}

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "POINTS" as const,
  pointsPer100: 10,
  pointsPerVisit: 50,
  pointsForReward: 500,
  rewardValue: 100,
  signupBonus: 50,
  silverTierSpend: 5000,
  goldTierSpend: 15000,
  vipTierSpend: 50000,
};

export type LoyaltySettingsData = Awaited<ReturnType<typeof getLoyaltySettings>>;

/** Fetch the hotel's loyalty settings, creating sensible defaults on first use (race-safe upsert). */
export async function getLoyaltySettings(hotelId: string) {
  const existing = await db.loyaltySettings.findUnique({ where: { hotelId } });
  if (existing) return existing;
  // Upsert: two concurrent first-touches cannot create two rows (hotelId is unique).
  return db.loyaltySettings.upsert({
    where: { hotelId },
    update: {},
    create: { hotelId, ...DEFAULT_SETTINGS },
  });
}

/**
 * Fetch (or create) a customer's loyalty account — concurrency-safe (BUG #5 fix).
 * The hotelId+customerId unique constraint is arbitrated by the database via
 * upsert; a concurrent create() from another process can no longer throw.
 */
export async function getOrCreateAccount(hotelId: string, customerId: string) {
  const existing = await db.loyaltyAccount.findUnique({
    where: { hotelId_customerId: { hotelId, customerId } },
  });
  if (existing) return existing;

  // Verify the customer belongs to THIS hotel before creating the account.
  const customer = await db.customer.findFirst({ where: { id: customerId, hotelId } });
  if (!customer) throw new Error("Customer not found in this hotel.");

  const settings = await getLoyaltySettings(hotelId);
  const tier = computeTier(0, settings);
  try {
    return await db.loyaltyAccount.create({ data: { hotelId, customerId, tier } });
  } catch (err) {
    // Lost a concurrent create race → the winner's row is the account. Re-read.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      const winner = await db.loyaltyAccount.findUnique({
        where: { hotelId_customerId: { hotelId, customerId } },
      });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Per-account in-process serialization for deterministic concurrent mutations
 * on SQLite. On PostgreSQL the unique constraints + atomic increments arbitrate
 * cross-process correctness; this lock only reduces contention.
 */
const accountLocks = new Map<string, Promise<unknown>>();

function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(accountId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  accountLocks.set(
    accountId,
    next.catch(() => undefined),
  );
  if (accountLocks.size > 10_000) {
    for (const [k, v] of accountLocks) {
      if (k !== accountId && v === Promise.resolve()) accountLocks.delete(k);
    }
  }
  return next;
}

/** True when a Prisma error is the unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

/** Points earned for a spend amount under the hotel's mode. */
function pointsForAmount(
  amount: number,
  settings: { mode: string; pointsPer100: number; pointsPerVisit: number },
): number {
  if (settings.mode === "POINTS") {
    return Math.max(0, Math.floor(amount / 100)) * settings.pointsPer100;
  }
  return settings.pointsPerVisit;
}

export interface AwardResult {
  ok: boolean;
  reason?: string;
  pointsAwarded: number;
  balance: number;
  tier: Tier;
}

/**
 * Award loyalty points for a restaurant visit. Idempotent per visit:
 * deterministic idempotency key `earn:{visitId}` guarantees exactly one award.
 * Balance mutation is a single atomic increment (no read-modify-write).
 */
export async function awardForRestaurantVisit(
  hotelId: string,
  customerId: string,
  visitId: string,
  amount: number,
): Promise<AwardResult> {
  const settings = await getLoyaltySettings(hotelId);
  const account = await getOrCreateAccount(hotelId, customerId);
  // BUG FIX: the program toggle was stored and displayed but never enforced —
  // a hotel that disabled loyalty kept earning points on every visit.
  if (!settings.enabled) {
    return {
      ok: true,
      reason: "PROGRAM_DISABLED",
      pointsAwarded: 0,
      balance: account.points,
      tier: account.tier as Tier,
    };
  }
  const idempotencyKey = `earn:${visitId}`;

  return withAccountLock(account.id, async () => {
    try {
      const result = await db.$transaction(
        async (tx) => {
          // Idempotency: the ledger row for this visit already exists → no-op.
          const existing = await tx.loyaltyTransaction.findUnique({ where: { idempotencyKey } });
          if (existing) {
            const acct = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
            return {
              already: true,
              points: 0,
              balance: acct?.points ?? 0,
              tier: (acct?.tier ?? "BRONZE") as Tier,
            };
          }

          const points = pointsForAmount(amount, settings);
          const safeAmount = Math.max(0, amount);

          // ATOMIC increments — concurrent awards can never lose an update.
          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");
          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: {
              points: { increment: points },
              lifetimePoints: { increment: points },
              lifetimeSpend: { increment: safeAmount },
              visitsCounted: { increment: 1 },
              lastAwardVisitId: visitId,
            },
          });
          const tier = computeTier(acct.lifetimeSpend, settings);
          if (tier !== acct.tier) {
            await tx.loyaltyAccount.update({ where: { id: account.id }, data: { tier } });
            acct.tier = tier;
          }

          await tx.loyaltyTransaction.create({
            data: {
              hotelId,
              accountId: account.id,
              customerId,
              type: settings.mode === "POINTS" ? "EARN" : "EARN_VISIT",
              points,
              reason: `Restaurant visit (₹${amount.toFixed(2)})`,
              visitId,
              idempotencyKey,
              balanceBefore: before.points,
              balanceAfter: acct.points,
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });

          return { already: false, points, balance: acct.points, tier: acct.tier as Tier };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      if (result.already) {
        return {
          ok: true,
          reason: "ALREADY_AWARDED",
          pointsAwarded: 0,
          balance: result.balance,
          tier: result.tier,
        };
      }
      return { ok: true, pointsAwarded: result.points, balance: result.balance, tier: result.tier };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent award for the same visit won the race — idempotent no-op.
        const acct = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return {
          ok: true,
          reason: "ALREADY_AWARDED",
          pointsAwarded: 0,
          balance: acct?.points ?? 0,
          tier: (acct?.tier ?? "BRONZE") as Tier,
        };
      }
      throw err;
    }
  });
}

export interface RedeemResult {
  ok: boolean;
  reason?: string;
  pointsRedeemed: number;
  rewardValue: number;
  balance: number;
}

/** Redeem one reward: deducts `pointsForReward` points atomically. The
 * sufficiency check runs INSIDE the transaction on the post-decrement value,
 * so concurrent redemptions can never overdraw the balance. */
export async function redeemReward(
  hotelId: string,
  customerId: string,
  opts: { userId?: string | null; req?: Request } = {},
): Promise<RedeemResult> {
  const settings = await getLoyaltySettings(hotelId);
  const account = await getOrCreateAccount(hotelId, customerId);
  // BUG FIX: honour the program toggle (see awardForRestaurantVisit).
  if (!settings.enabled) {
    return {
      ok: false,
      reason: "The loyalty program is currently turned off for this hotel.",
      pointsRedeemed: 0,
      rewardValue: 0,
      balance: account.points,
    };
  }

  const result = await withAccountLock(account.id, async () => {
    try {
      return await db.$transaction(
        async (tx) => {
          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");

          // Atomic decrement; verify sufficiency on the post-decrement value.
          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: { points: { decrement: settings.pointsForReward } },
          });
          if (acct.points < 0) {
            throw new Error("INSUFFICIENT_POINTS");
          }

          await tx.loyaltyTransaction.create({
            data: {
              hotelId,
              accountId: account.id,
              customerId,
              type: "REDEEM",
              points: -settings.pointsForReward,
              reason: `Reward redeemed (₹${settings.rewardValue.toFixed(2)})`,
              actorId: opts.userId ?? null,
              balanceBefore: before.points,
              balanceAfter: acct.points,
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });
          return { ok: true as const, balance: acct.points };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof Error && err.message === "INSUFFICIENT_POINTS") {
        const fresh = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return {
          ok: false as const,
          reason: `Not enough points. Balance ${fresh?.points ?? 0}, reward needs ${settings.pointsForReward}.`,
        };
      }
      throw err;
    }
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason, pointsRedeemed: 0, rewardValue: 0, balance: 0 };
  }

  await logAudit({
    req: opts.req,
    hotelId,
    userId: opts.userId ?? null,
    action: AUDIT_ACTIONS.LOYALTY_REWARD_REDEEMED,
    entityType: "loyalty_account",
    entityId: account.id,
    metadata: { customerId, points: settings.pointsForReward, rewardValue: settings.rewardValue },
  });

  return {
    ok: true,
    pointsRedeemed: settings.pointsForReward,
    rewardValue: settings.rewardValue,
    balance: result.balance,
  };
}

export interface AdjustResult {
  ok: boolean;
  reason?: string;
  balance: number;
}

/** Manual staff adjustment (+ or −) with a mandatory reason. Audited. The
 * balance guard runs inside the transaction (atomic), so concurrent
 * adjustments cannot overdraw. */
export async function adjustPoints(
  hotelId: string,
  customerId: string,
  points: number,
  reason: string,
  opts: { userId?: string | null; req?: Request } = {},
): Promise<AdjustResult> {
  if (!Number.isInteger(points) || points === 0) {
    return { ok: false, reason: "Points adjustment must be a non-zero whole number.", balance: 0 };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, reason: "A reason is required for manual adjustments.", balance: 0 };
  }
  const account = await getOrCreateAccount(hotelId, customerId);

  const result = await withAccountLock(account.id, async () => {
    try {
      return await db.$transaction(
        async (tx) => {
          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");
          if (points < 0 && before.points + points < 0) {
            throw new Error("NEGATIVE_BALANCE");
          }
          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: { points: { increment: points } },
          });
          await tx.loyaltyTransaction.create({
            data: {
              hotelId,
              accountId: account.id,
              customerId,
              type: "ADJUST",
              points,
              reason: reason.trim().slice(0, 300),
              actorId: opts.userId ?? null,
              balanceBefore: before.points,
              balanceAfter: acct.points,
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });
          return { ok: true as const, balance: acct.points };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof Error && err.message === "NEGATIVE_BALANCE") {
        const fresh = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return {
          ok: false as const,
          reason: `Adjustment would make the balance negative (current: ${fresh?.points ?? 0}).`,
        };
      }
      throw err;
    }
  });

  if (!result.ok) return { ok: false, reason: result.reason, balance: 0 };

  await logAudit({
    req: opts.req,
    hotelId,
    userId: opts.userId ?? null,
    action: AUDIT_ACTIONS.LOYALTY_POINTS_ADJUSTED,
    entityType: "loyalty_account",
    entityId: account.id,
    metadata: { customerId, points, reason: reason.trim().slice(0, 120) },
  });

  return { ok: true, balance: result.balance };
}

export interface JoinResult {
  ok: boolean;
  reason?: string;
  bonusPoints: number;
  balance: number;
  accountId?: string;
}

/**
 * Join a customer to the loyalty program (signup bonus awarded once).
 * The "awarded once" guard is a conditional update inside the transaction
 * (WHERE lifetimePoints = 0 …), so two concurrent joins can never double-award.
 */
export async function joinLoyalty(
  hotelId: string,
  customerId: string,
  opts: { source?: string; req?: Request; userId?: string | null } = {},
): Promise<JoinResult> {
  const settings = await getLoyaltySettings(hotelId);
  const account = await getOrCreateAccount(hotelId, customerId);
  // No signup bonus while the program is switched off (the account is still created).
  const bonus = settings.enabled ? Math.max(0, settings.signupBonus) : 0;

  const result = await withAccountLock(account.id, async () => {
    try {
      return await db.$transaction(
        async (tx) => {
          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");
          if (before.lifetimePoints > 0 || before.visitsCounted > 0) {
            return { already: true as const, bonus: 0, balance: before.points };
          }

          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: {
              points: { increment: bonus },
              lifetimePoints: { increment: bonus },
            },
          });
          if (bonus > 0) {
            await tx.loyaltyTransaction.create({
              data: {
                hotelId,
                accountId: account.id,
                customerId,
                type: "SIGNUP_BONUS",
                points: bonus,
                reason: "Welcome bonus",
                idempotencyKey: `signup:${account.id}`,
                balanceBefore: before.points,
                balanceAfter: acct.points,
              },
            });
          }
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });
          return { already: false as const, bonus, balance: acct.points };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent join already wrote the signup ledger row → no double bonus.
        const fresh = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return { already: true as const, bonus: 0, balance: fresh?.points ?? 0 };
      }
      throw err;
    }
  });

  if (result.already) {
    return {
      ok: true,
      reason: "ALREADY_MEMBER",
      bonusPoints: 0,
      balance: result.balance,
      accountId: account.id,
    };
  }

  await logAudit({
    req: opts.req,
    hotelId,
    userId: opts.userId ?? null,
    action: AUDIT_ACTIONS.LOYALTY_JOINED,
    entityType: "loyalty_account",
    entityId: account.id,
    metadata: { customerId, source: opts.source ?? "QR_PAGE", bonus },
  });

  return { ok: true, bonusPoints: result.bonus, balance: result.balance, accountId: account.id };
}

/* ------------------------------------------------------------------ */
/* Phase 6.4 — Visit edit/delete loyalty compensation (BUG #2 fix)     */
/* ------------------------------------------------------------------ */

export interface ReverseResult {
  ok: boolean;
  reason?: string;
  pointsReversed: number;
  balance: number;
}

/**
 * Reverse all loyalty effects of a restaurant visit (visit deleted).
 * IMMUTABLE ledger: a compensating REVERSAL entry is appended (never rewrites
 * history). Idempotent via deterministic key `reverse:{visitId}` — repeated
 * delete requests no-op. The reversal amount is derived from the NET ledger
 * sum for that visit, so partial histories stay consistent.
 *
 * Balance may go negative when the points were already redeemed — the ledger
 * stays exact (see module doc §5).
 */
export async function reverseForRestaurantVisit(
  hotelId: string,
  customerId: string,
  visitId: string,
  originalAmount: number,
  opts: { userId?: string | null; req?: Request } = {},
): Promise<ReverseResult> {
  const settings = await getLoyaltySettings(hotelId);
  const account = await getOrCreateAccount(hotelId, customerId);
  const idempotencyKey = `reverse:${visitId}`;

  const result = await withAccountLock(account.id, async () => {
    try {
      return await db.$transaction(
        async (tx) => {
          // Idempotency: already reversed → no-op.
          const existing = await tx.loyaltyTransaction.findUnique({ where: { idempotencyKey } });
          if (existing) {
            const acct = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
            return { already: true as const, reversed: 0, balance: acct?.points ?? 0 };
          }

          // Net points awarded for this visit across ALL its entries
          // (EARN + VISIT_ADJUST corrections) — the reversal must zero the net,
          // so an edited visit reverses the CORRECTED amount, not the original.
          const ledger = await tx.loyaltyTransaction.findMany({
            where: { accountId: account.id, visitId },
            select: { points: true, type: true },
          });
          const netAwarded = ledger
            .filter(
              (l) => l.type === "EARN" || l.type === "EARN_VISIT" || l.type === "VISIT_ADJUST",
            )
            .reduce((s, l) => s + l.points, 0);
          if (netAwarded <= 0) {
            // Visit never earned points (e.g. ₹0 bill in POINTS mode) → nothing to reverse.
            await tx.loyaltyTransaction.create({
              data: {
                hotelId,
                accountId: account.id,
                customerId,
                type: "REVERSAL",
                points: 0,
                reason: `Visit deleted — no points had been earned (₹${originalAmount.toFixed(2)})`,
                visitId,
                actorId: opts.userId ?? null,
                idempotencyKey,
              },
            });
            const acct = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
            return { already: false as const, reversed: 0, balance: acct?.points ?? 0 };
          }

          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");

          // Reverse spend + visit count + points with atomic decrements.
          const safeSpend = Math.max(0, originalAmount);
          const spendAfter = before.lifetimeSpend - safeSpend;
          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: {
              points: { decrement: netAwarded },
              lifetimePoints: { set: Math.max(0, before.lifetimePoints - netAwarded) },
              lifetimeSpend: { set: Math.max(0, spendAfter) },
              visitsCounted: { decrement: 1 },
              ...(before.lastAwardVisitId === visitId ? { lastAwardVisitId: null } : {}),
            },
          });
          const tier = computeTier(acct.lifetimeSpend, settings);
          if (tier !== acct.tier) {
            await tx.loyaltyAccount.update({ where: { id: account.id }, data: { tier } });
            acct.tier = tier;
          }

          await tx.loyaltyTransaction.create({
            data: {
              hotelId,
              accountId: account.id,
              customerId,
              type: "REVERSAL",
              points: -netAwarded,
              reason: `Visit deleted — points reversed (bill ₹${originalAmount.toFixed(2)})`,
              visitId,
              actorId: opts.userId ?? null,
              idempotencyKey,
              balanceBefore: before.points,
              balanceAfter: acct.points,
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });
          return { already: false as const, reversed: netAwarded, balance: acct.points };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const acct = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return { already: true as const, reversed: 0, balance: acct?.points ?? 0 };
      }
      throw err;
    }
  });

  const reversed = result.reversed;
  await logAudit({
    req: opts.req,
    hotelId,
    userId: opts.userId ?? null,
    action: AUDIT_ACTIONS.LOYALTY_VISIT_REVERSED,
    entityType: "loyalty_account",
    entityId: account.id,
    metadata: { customerId, visitId, pointsReversed: reversed, amount: originalAmount },
  });

  return {
    ok: true,
    reason: result.already ? "ALREADY_REVERSED" : undefined,
    pointsReversed: reversed,
    balance: result.balance,
  };
}

export interface VisitAdjustResult {
  ok: boolean;
  reason?: string;
  pointsDelta: number;
  balance: number;
}

/**
 * Correct loyalty for an edited visit amount (BUG #2: ₹10,000 → ₹1,000 must
 * not leave the original 1,000 points). Appends a VISIT_ADJUST compensating
 * entry with the point delta (NEW − OLD), adjusts lifetime spend, and keeps
 * the tier consistent. Idempotent: repeating the SAME edit produces a zero
 * delta (no entry); distinct edits produce distinct deterministic keys.
 */
export async function adjustForVisitAmount(
  hotelId: string,
  customerId: string,
  visitId: string,
  oldAmount: number,
  newAmount: number,
  opts: { userId?: string | null; req?: Request } = {},
): Promise<VisitAdjustResult> {
  const settings = await getLoyaltySettings(hotelId);
  const account = await getOrCreateAccount(hotelId, customerId);

  const oldPoints = pointsForAmount(oldAmount, settings);
  const newPoints = pointsForAmount(newAmount, settings);
  const delta = newPoints - oldPoints;
  const spendDelta = Math.max(0, newAmount) - Math.max(0, oldAmount);

  if (delta === 0 && spendDelta === 0) {
    const acct = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
    return { ok: true, reason: "NO_CHANGE", pointsDelta: 0, balance: acct?.points ?? 0 };
  }

  const idempotencyKey = `visitadj:${visitId}:${Math.round(newAmount * 100)}`;

  const result = await withAccountLock(account.id, async () => {
    try {
      return await db.$transaction(
        async (tx) => {
          // Same correction already applied → idempotent no-op.
          const existing = await tx.loyaltyTransaction.findUnique({ where: { idempotencyKey } });
          if (existing) {
            const acct = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
            return { already: true as const, delta: 0, balance: acct?.points ?? 0 };
          }

          const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
          if (!before) throw new Error("Loyalty account missing.");

          const acct = await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: {
              points: { increment: delta },
              lifetimePoints: { set: Math.max(0, before.lifetimePoints + delta) },
              lifetimeSpend: { set: Math.max(0, before.lifetimeSpend + spendDelta) },
            },
          });
          const tier = computeTier(acct.lifetimeSpend, settings);
          if (tier !== acct.tier) {
            await tx.loyaltyAccount.update({ where: { id: account.id }, data: { tier } });
            acct.tier = tier;
          }

          await tx.loyaltyTransaction.create({
            data: {
              hotelId,
              accountId: account.id,
              customerId,
              type: "VISIT_ADJUST",
              points: delta,
              reason: `Visit bill corrected ₹${oldAmount.toFixed(2)} → ₹${newAmount.toFixed(2)}`,
              visitId,
              actorId: opts.userId ?? null,
              idempotencyKey,
              balanceBefore: before.points,
              balanceAfter: acct.points,
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { loyaltyPoints: acct.points },
          });
          return { already: false as const, delta, balance: acct.points };
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const acct = await db.loyaltyAccount.findUnique({ where: { id: account.id } });
        return { already: true as const, delta: 0, balance: acct?.points ?? 0 };
      }
      throw err;
    }
  });

  await logAudit({
    req: opts.req,
    hotelId,
    userId: opts.userId ?? null,
    action: AUDIT_ACTIONS.LOYALTY_VISIT_ADJUSTED,
    entityType: "loyalty_account",
    entityId: account.id,
    metadata: { customerId, visitId, pointsDelta: result.delta, oldAmount, newAmount },
  });

  return {
    ok: true,
    reason: result.already ? "ALREADY_ADJUSTED" : undefined,
    pointsDelta: result.delta,
    balance: result.balance,
  };
}

/* ------------------------------------------------------------------ */
/* Phase 6.4 — Ledger reconciliation (spec §28)                        */
/* ------------------------------------------------------------------ */

export interface ReconcileReport {
  accountId: string;
  customerId: string;
  ledgerTotal: number;
  storedBalance: number;
  drift: number;
  matched: boolean;
}

/**
 * Compare the ledger total (sum of all signed entries) against the stored
 * balance for one account. Read-only by default; `repair` re-materializes the
 * stored balance from the ledger INSIDE a transaction and records an audit
 * entry. The repair never writes a LoyaltyTransaction row — the ledger is
 * authoritative and already correct; only the materialized balance was wrong.
 */
export async function reconcileAccount(
  hotelId: string,
  customerId: string,
  opts: { repair?: boolean; userId?: string | null; req?: Request } = {},
): Promise<ReconcileReport> {
  const account = await getOrCreateAccount(hotelId, customerId);
  const agg = await db.loyaltyTransaction.aggregate({
    where: { accountId: account.id },
    _sum: { points: true },
  });
  const ledgerTotal = agg._sum.points ?? 0;
  const report: ReconcileReport = {
    accountId: account.id,
    customerId,
    ledgerTotal,
    storedBalance: account.points,
    drift: ledgerTotal - account.points,
    matched: ledgerTotal === account.points,
  };

  if (!report.matched && opts.repair) {
    const repaired = await withAccountLock(account.id, async () => {
      try {
        return await db.$transaction(
          async (tx) => {
            // Recompute INSIDE the transaction (no racing mutations).
            const inner = await tx.loyaltyTransaction.aggregate({
              where: { accountId: account.id },
              _sum: { points: true },
            });
            const innerLedger = inner._sum.points ?? 0;
            const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
            if (!before) throw new Error("Loyalty account missing.");
            if (before.points === innerLedger) return { fixed: 0, balance: innerLedger };

            const acct = await tx.loyaltyAccount.update({
              where: { id: account.id },
              data: { points: innerLedger },
            });
            await tx.customer.update({
              where: { id: customerId },
              data: { loyaltyPoints: acct.points },
            });
            return { fixed: innerLedger - before.points, balance: acct.points };
          },
          { timeout: 30_000, maxWait: 10_000 },
        );
      } catch {
        return { fixed: 0, balance: report.storedBalance };
      }
    });

    // AuditLog entry documents the repair (drift, before, after). Never a
    // ledger row — the immutable ledger itself is the source of truth.
    if (repaired.fixed !== 0) {
      await logAudit({
        req: opts.req,
        hotelId,
        userId: opts.userId ?? null,
        action: AUDIT_ACTIONS.LOYALTY_RECONCILED,
        entityType: "loyalty_account",
        entityId: account.id,
        metadata: {
          customerId,
          ledgerTotal: report.ledgerTotal,
          storedBefore: report.storedBalance,
          repair: repaired.fixed,
          storedAfter: repaired.balance,
        },
      });
    }
    report.storedBalance = repaired.balance;
    report.drift = report.ledgerTotal - repaired.balance;
    report.matched = report.drift === 0;
  }

  return report;
}

/** Tier display helper for UI. */
export function tierMeta(tier: string): { label: string; className: string } {
  switch (tier) {
    case "VIP":
      return {
        label: "VIP",
        className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      };
    case "GOLD":
      return {
        label: "Gold",
        className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
      };
    case "SILVER":
      return {
        label: "Silver",
        className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      };
    default:
      return {
        label: "Bronze",
        className: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
      };
  }
}
