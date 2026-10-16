/**
 * Phase 14 — POS, GST billing & restaurant payments service.
 *
 * Core guarantees (mirrors the COMMON MASTER RULES):
 *  - MONEY IS INTEGER MINOR UNITS. No float ever touches a stored total.
 *    Rounding: round half-up at line level; the bill total is the exact sum
 *    of line totals; roundOffMinor carries the whole-rupee adjustment.
 *  - TOTALS CONSERVE under splits/refunds: sum(payments) == paidMinor <=
 *    totalMinor; a refund can never exceed (paidMinor - refundMinor).
 *  - TAX IS EFFECTIVE-DATED. The bill freezes the applied rules into
 *    taxSnapshot + per-line taxBreakup — later rule edits never mutate an
 *    issued bill (historical tax mutation is impossible by construction).
 *  - INVOICE NUMBERS ARE SEQUENTIAL PER TENANT PER FINANCIAL YEAR, drawn
 *    inside the issuing transaction (concurrent cashiers serialize on the
 *    sequence row — no gaps from rejected concurrency, no duplicates).
 *  - LOYALTY/VISIT UPDATES RUN EXACTLY ONCE per bill via the same
 *    transactional path the Phase 13 order engine uses (idempotency keys),
 *    plus a durable RESTAURANT_BILL_PAID outbox job for async followups.
 *  - MANUAL payments are labelled RECORDED/MANUAL — never presented as
 *    gateway-verified. Gateway captures require server-side verification.
 */

import { createHash, createHmac, timingSafeEqual, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { normalizeCouponCode, validateCoupon, computeDiscount } from "@/lib/coupons";
import type { Prisma } from "@prisma/client";

/* ------------------------------------------------------------------ */
/* Money helpers                                                       */
/* ------------------------------------------------------------------ */

/** Round half-up to the nearest integer minor unit (deterministic). */
export function roundMinor(value: number): number {
  return Math.floor(value + 0.5);
}

/** Indian financial-year key for a date: Apr 1 → Mar 31, e.g. "2025-26". */
export function financialYearOf(date: Date, tzOffsetMinutes = 330): string {
  // Tenant-local date via explicit offset (default IST +05:30). UTC storage
  // stays untouched — this only derives the series label.
  const local = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth(); // 0-11
  const startYear = m >= 3 ? y : y - 1; // Apr (3) onwards belongs to FY y
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endShort}`;
}

/* ------------------------------------------------------------------ */
/* Tax engine                                                          */
/* ------------------------------------------------------------------ */

export interface TaxRuleSnapshot {
  ruleId: string;
  name: string;
  type: string;
  rateBps: number;
  isInclusive: boolean;
  scopeType: string;
  scopeIds: string[];
  cgstMinor?: number;
  sgstMinor?: number;
  igstMinor?: number;
  taxMinor?: number;
  taxableMinor?: number;
}

export interface TaxedLine {
  taxableMinor: number; // value tax is computed on (exclusive basis)
  taxMinor: number; // total tax for the line
  lineTotalMinor: number; // final payable for the line
  taxBreakup: Array<{ name: string; type: string; rateBps: number; amountMinor: number }>;
  appliedRules: TaxRuleSnapshot[];
}

interface ActiveRule {
  id: string;
  name: string;
  type: "CGST_SGST" | "IGST" | "EXEMPT";
  rateBps: number;
  isInclusive: boolean;
  scopeType: string;
  scopeIds: string[];
  // Present for rules loaded from the DB (activeTaxRulesFor). Optional so
  // direct callers/tests can pass bare rule literals.
  effectiveFrom?: Date;
}

/**
 * Load tax rules active for the hotel AT the bill time. Effective-dated:
 * effectiveFrom <= at < (effectiveTo ?? ∞) and active. Scoped rules match
 * when ANY of their scope ids covers the line's category/item.
 */
export async function activeTaxRulesFor(
  hotelId: string,
  at: Date,
  menuItemIds: string[],
  categoryIds: string[],
): Promise<ActiveRule[]> {
  const rules = await db.taxRule.findMany({
    where: {
      hotelId,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  const itemSet = new Set(menuItemIds);
  const catSet = new Set(categoryIds);
  return rules
    .filter((r) => {
      if (r.scopeType === "ALL") return true;
      let ids: string[] = [];
      try {
        ids = JSON.parse(r.scopeIds ?? "[]");
      } catch {
        return false;
      }
      if (!Array.isArray(ids) || ids.length === 0) return false;
      if (r.scopeType === "ITEM") return ids.some((id) => itemSet.has(id));
      if (r.scopeType === "CATEGORY") return ids.some((id) => catSet.has(id));
      return false;
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      rateBps: r.rateBps,
      isInclusive: r.isInclusive,
      scopeType: r.scopeType,
      effectiveFrom: r.effectiveFrom,
      scopeIds: (() => {
        try {
          return JSON.parse(r.scopeIds ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
    }));
}

/**
 * AUDIT FIX (P14-TAX-1): overlapping rules used to STACK per line
 * (e.g. an old open-ended ALL rule plus a new ITEM rule = 5% + 12% = 17%).
 * Correct GST semantics: exactly ONE rate applies per line. Selection:
 *   1. most specific scope wins (ITEM > CATEGORY > ALL),
 *   2. EXEMPT beats a taxable rule at the same scope,
 *   3. otherwise the latest effectiveFrom wins (the "until superseded"
 *      contract documented on the TaxRule model).
 */
const SCOPE_RANK: Record<string, number> = { ITEM: 0, CATEGORY: 1, ALL: 2 };
export function pickBestRuleForLine<
  T extends { scopeType: string; type: string; effectiveFrom?: Date | null },
>(rules: T[]): T | null {
  if (rules.length === 0) return null;
  return [...rules].sort((a, b) => {
    const ra = SCOPE_RANK[a.scopeType] ?? 3;
    const rb = SCOPE_RANK[b.scopeType] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.type === "EXEMPT" && b.type !== "EXEMPT") return -1;
    if (b.type === "EXEMPT" && a.type !== "EXEMPT") return 1;
    return (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0);
  })[0];
}

/**
 * AUDIT FIX (P14-DISC-1): split `totalMinor` across `weights`
 * proportionally using the LARGEST-REMAINDER method so the parts always sum
 * to exactly `totalMinor` (no lost/invented paise from per-line rounding).
 */
export function allocateProportional(totalMinor: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (totalMinor <= 0) return weights.map(() => 0);
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sumW) * totalMinor);
  const base = raw.map((v) => Math.floor(v));
  let rem = totalMinor - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rem <= 0) break;
    base[o.i] += 1;
    rem -= 1;
  }
  return base;
}

/**
 * Apply tax rules to one bill line.
 *
 * INCLUSIVE pricing: printed price already contains tax → taxable base =
 * printed / (1 + rate). Tax = printed - base (exact, no rounding drift).
 * EXCLUSIVE pricing: tax = roundMinor(printed × rate).
 * CGST_SGST splits the tax into two equal halves (odd paise go to CGST).
 */
export function taxForLine(
  printedLineSubtotalMinor: number,
  rules: ActiveRule[],
): TaxedLine {
  // No rules → line passes through untaxed (printed = payable).
  if (rules.length === 0) {
    return {
      taxableMinor: printedLineSubtotalMinor,
      taxMinor: 0,
      lineTotalMinor: printedLineSubtotalMinor,
      taxBreakup: [],
      appliedRules: [],
    };
  }

  const applied: TaxRuleSnapshot[] = [];
  const breakup: TaxedLine["taxBreakup"] = [];
  let runningBase = printedLineSubtotalMinor; // exclusive-of-remaining-tax base
  let totalTax = 0;
  let exclusiveTax = 0; // tax ADDED on top of the printed price

  for (const rule of rules) {
    if (rule.type === "EXEMPT" || rule.rateBps === 0) {
      applied.push({
        ruleId: rule.id,
        name: rule.name,
        type: rule.type,
        rateBps: rule.rateBps,
        isInclusive: rule.isInclusive,
        scopeType: rule.scopeType,
        scopeIds: rule.scopeIds,
        taxMinor: 0,
        taxableMinor: runningBase,
      });
      continue;
    }
    let taxMinor: number;
    let taxableMinor: number;
    if (rule.isInclusive) {
      // Extract the embedded tax from the remaining gross.
      const gross = runningBase;
      taxableMinor = roundMinor((gross * 10_000) / (10_000 + rule.rateBps));
      taxMinor = gross - taxableMinor;
      runningBase = taxableMinor;
    } else {
      taxableMinor = runningBase;
      taxMinor = roundMinor((taxableMinor * rule.rateBps) / 10_000);
      exclusiveTax += taxMinor;
    }
    totalTax += taxMinor;
    if (rule.type === "CGST_SGST") {
      const half = Math.floor(taxMinor / 2);
      const cgst = taxMinor % 2 === 0 ? half : half + 1; // odd paise → CGST
      const sgst = taxMinor - cgst;
      breakup.push({ name: `${rule.name} (CGST)`, type: "CGST", rateBps: Math.round(rule.rateBps / 2), amountMinor: cgst });
      breakup.push({ name: `${rule.name} (SGST)`, type: "SGST", rateBps: Math.round(rule.rateBps / 2), amountMinor: sgst });
      applied.push({
        ruleId: rule.id,
        name: rule.name,
        type: rule.type,
        rateBps: rule.rateBps,
        isInclusive: rule.isInclusive,
        scopeType: rule.scopeType,
        scopeIds: rule.scopeIds,
        cgstMinor: cgst,
        sgstMinor: sgst,
        taxMinor,
        taxableMinor,
      });
    } else {
      breakup.push({ name: rule.name, type: "IGST", rateBps: rule.rateBps, amountMinor: taxMinor });
      applied.push({
        ruleId: rule.id,
        name: rule.name,
        type: rule.type,
        rateBps: rule.rateBps,
        isInclusive: rule.isInclusive,
        scopeType: rule.scopeType,
        scopeIds: rule.scopeIds,
        igstMinor: taxMinor,
        taxMinor,
        taxableMinor,
      });
    }
  }

  return {
    taxableMinor: runningBase,
    taxMinor: totalTax,
    // INCLUSIVE: payable = printed gross (tax already inside).
    // EXCLUSIVE: payable = printed gross + added tax.
    lineTotalMinor: printedLineSubtotalMinor + exclusiveTax,
    taxBreakup: breakup,
    appliedRules: applied,
  };
}

/* ------------------------------------------------------------------ */
/* Invoice numbering (per tenant, per financial year, concurrency-safe) */
/* ------------------------------------------------------------------ */

/** Draw the next sequential invoice number inside the caller's transaction. */
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  hotelId: string,
  at: Date,
): Promise<{ series: string; seqNumber: number; billNumber: string }> {
  const series = financialYearOf(at);
  // Atomic upsert-increment: the unique (hotelId, series) row serializes
  // concurrent cashiers; the increment is durable in the same transaction.
  const seq = await tx.invoiceSequence.upsert({
    where: { hotelId_series: { hotelId, series } },
    create: { hotelId, series, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  const seqNumber = seq.lastNumber;
  const billNumber = `${seq.prefix ?? "INV"}/${series}/${String(seqNumber).padStart(6, "0")}`;
  return { series, seqNumber, billNumber };
}

/* ------------------------------------------------------------------ */
/* Bill creation from a table session                                  */
/* ------------------------------------------------------------------ */

export interface CreateBillInput {
  hotelId: string;
  issuedByUserId: string;
  tableSessionId?: string | null;
  /** Explicit order ids to bill (defaults: all non-cancelled session orders). */
  orderIds?: string[];
  couponCode?: string;
  customerId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  /** Manual discount in minor units (requires reason; permission-checked upstream). */
  manualDiscountMinor?: number;
  manualDiscountReason?: string;
  idempotencyKey?: string | null;
}

export class BillValidationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export interface CreatedBill {
  id: string;
  billNumber: string;
  totalMinor: number;
  currency: string;
}

/**
 * Is a promotion's day/time window open at `now` in the tenant timezone?
 *
 * BUG FIX: days are stored as "MON".."SUN" (promotions API + UI) but were
 * compared with Intl's "Mon".."Sun", so a promotion restricted to ANY day of
 * the week never applied. Compared case-insensitively now.
 */
export function promotionWindowOpen(
  promo: { type: string; daysOfWeek: string | null; startTime: string | null; endTime: string | null },
  now: Date,
  tz: string,
): boolean {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => local.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday").toUpperCase();
  const minutesOfDay = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  if (promo.daysOfWeek) {
    try {
      const days = JSON.parse(promo.daysOfWeek) as unknown;
      if (Array.isArray(days) && days.length > 0 && !days.some((d) => String(d).toUpperCase() === weekday)) return false;
    } catch {
      return false; // malformed window — never apply
    }
  }
  if (promo.type === "HAPPY_HOUR") {
    if (!promo.startTime || !promo.endTime) return false;
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const start = toMin(promo.startTime);
    const end = toMin(promo.endTime);
    const inWindow = start <= end ? minutesOfDay >= start && minutesOfDay < end : minutesOfDay >= start || minutesOfDay < end;
    if (!inWindow) return false;
  }
  return true;
}

/**
 * Create a bill from a table session's SERVED (or at least placed) orders.
 * Pricing snapshot comes from the immutable OrderItem snapshots — the catalog
 * cannot rewrite history. Coupon redemption happens transactionally.
 */
export async function createBillFromSession(input: CreateBillInput): Promise<CreatedBill> {
  const { hotelId, issuedByUserId } = input;

  if (input.idempotencyKey) {
    const existing = await db.bill.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing && existing.hotelId === hotelId) {
      return { id: existing.id, billNumber: existing.billNumber, totalMinor: existing.totalMinor, currency: existing.currency };
    }
  }

  // AUDIT FIX (P14-CUST-1): the customer must belong to THIS tenant. A
  // cross-tenant customer id previously opened the door to foreign loyalty
  // accounts, coupon redemptions and follow-up emails under this hotel.
  if (input.customerId) {
    const cust = await db.customer.findFirst({
      where: { id: input.customerId, hotelId },
      select: { id: true },
    });
    if (!cust) {
      throw new BillValidationError("Customer does not belong to this restaurant.", "CUSTOMER_INVALID");
    }
  }

  /* ---------------- Pre-transaction (db connection) ----------------
   * DEADLOCK NOTE (SQLite dev): the interactive transaction holds the single
   * write connection (connection_limit=1), so EVERY `db.*` call happens
   * BEFORE the transaction starts — only `tx.*` calls run inside. The
   * authoritative ALREADY_BILLED fence still runs INSIDE the transaction. */
  const where: Prisma.DiningOrderWhereInput = {
    hotelId,
    status: { not: "CANCELLED" },
    ...(input.tableSessionId ? { tableSessionId: input.tableSessionId } : {}),
    ...(input.orderIds && input.orderIds.length > 0 ? { id: { in: input.orderIds } } : {}),
  };
  const orders = await db.diningOrder.findMany({
    where,
    include: { items: true, table: { select: { id: true, number: true } } },
    orderBy: { placedAt: "asc" },
  });
  if (orders.length === 0) {
    throw new BillValidationError("No billable orders found for this session.", "NO_ORDERS");
  }

  // Aggregate items across orders (same item+options may appear twice).
  const lineKey = (item: { menuItemId: string | null; nameSnapshot: string; unitPriceMinor: number }) =>
    `${item.menuItemId ?? "x"}|${item.nameSnapshot}|${item.unitPriceMinor}`;
  const lines: Array<{
    orderId: string;
    orderItemId: string;
    menuItemId: string | null;
    categoryId: string | null;
    nameSnapshot: string;
    quantity: number;
    unitPriceMinor: number;
    lineSubtotalMinor: number;
    notes: string | null;
  }> = [];
  const index = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      if (item.status === "CANCELLED") continue;
      const key = lineKey(item);
      const at = index.get(key);
      if (at !== undefined && lines[at].orderId === order.id) {
        lines[at].quantity += item.quantity;
        lines[at].lineSubtotalMinor += item.lineTotalMinor;
      } else {
        index.set(key, lines.length);
        let categoryId: string | null = null;
        if (item.menuItemId) {
          const mi = await db.menuItem.findUnique({
            where: { id: item.menuItemId },
            select: { categoryId: true },
          });
          categoryId = mi?.categoryId ?? null;
        }
        lines.push({
          orderId: order.id,
          orderItemId: item.id,
          menuItemId: item.menuItemId,
          categoryId,
          nameSnapshot: item.nameSnapshot,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          lineSubtotalMinor: item.lineTotalMinor,
          notes: item.notes,
        });
      }
    }
  }

  const subtotalMinor = lines.reduce((s, l) => s + l.lineSubtotalMinor, 0);

  // --- Discounts: coupon (validated pre-txn, redeemed in-txn) or manual. ---
  let discountMinor = 0;
  let couponCode: string | null = null;
  let couponRow: { id: string; customerLimit: number } | null = null;
  let discountReason: string | null = null;
  let discountByUserId: string | null = null;

  if (input.couponCode) {
    if (!input.customerId) {
      // CouponRedemption carries a real customer relation — an anonymous
      // guest bill cannot hold one. The cashier attaches a customer
      // (phone lookup) first; this keeps redemption history accurate.
      throw new BillValidationError("Attach a customer (phone) to redeem a coupon.", "COUPON_REQUIRES_CUSTOMER");
    }
    const normalized = normalizeCouponCode(input.couponCode);
    const validation = await validateCoupon(normalized, input.customerId, hotelId, subtotalMinor / 100);
    if (!validation.valid) {
      throw new BillValidationError(validation.reason ?? "Coupon is not valid.", "COUPON_INVALID");
    }
    const coupon = await db.coupon.findUnique({ where: { hotelId_code: { hotelId, code: normalized } } });
    if (!coupon) {
      throw new BillValidationError("Coupon code not found.", "COUPON_INVALID");
    }
    const discount = computeDiscount(coupon, subtotalMinor / 100);
    if (discount <= 0) {
      throw new BillValidationError("Coupon discount is zero for this amount.", "COUPON_INVALID");
    }
    discountMinor = roundMinor(discount * 100);
    couponCode = normalized;
    couponRow = { id: coupon.id, customerLimit: coupon.customerLimit };
  } else if (input.manualDiscountMinor && input.manualDiscountMinor > 0) {
    if (!input.manualDiscountReason) {
      throw new BillValidationError("A reason is required for manual discounts.", "DISCOUNT_REASON_REQUIRED");
    }
    discountMinor = Math.min(input.manualDiscountMinor, subtotalMinor);
    discountReason = input.manualDiscountReason;
    discountByUserId = issuedByUserId;
  }

  // --- Tax rules (read pre-txn; effective-dated at issue time). ---
  const rules = await activeTaxRulesFor(
    hotelId,
    new Date(),
    lines.map((l) => l.menuItemId).filter((x): x is string => !!x),
    lines.map((l) => l.categoryId).filter((x): x is string => !!x),
  );

  // --- Legal snapshot (read pre-txn; frozen at issue). ---
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { name: true, address: true, city: true, state: true, gstin: true, phone: true, email: true, timezone: true },
  });

  // --- Promotion (AUDIT FIX P15-PRM-2): real server-side application. -----
  // Promotions were CRUD-only before — nothing ever affected money and the
  // Bill.promotion* columns were dead. Selected pre-txn, frozen on the bill:
  //   * one promotion per bill (highest discount; tie → higher priority);
  //   * PERCENT / FLAT / HAPPY_HOUR apply to in-scope lines (empty scope =
  //     whole bill); COMBO needs a combo-definition contract and is never
  //     silently applied (documented gap);
  //   * windows evaluate in the TENANT timezone (daysOfWeek, happy-hour);
  //   * a coupon excludes a promotion unless promotion.stackable;
  //   * the COMBINED discount is capped at the subtotal and allocated across
  //     lines with the same largest-remainder method — totals always conserve
  //     and no line can go negative.
  const nowForPromo = new Date();
  const promotionRows = await db.promotion.findMany({ where: { hotelId, active: true } });
  const appliedPromotion: { id: string; name: string; version: number; label: string; discount: number } | null = (() => {
    const tz = hotel?.timezone || "Asia/Kolkata";
    const candidates: Array<{ row: (typeof promotionRows)[number]; discount: number }> = [];
    for (const promo of promotionRows) {
      if (couponCode && !promo.stackable) continue;
      if (promo.startDate && promo.startDate > nowForPromo) continue;
      if (promo.endDate && promo.endDate <= nowForPromo) continue;
      if (promo.type === "COMBO") continue; // needs a combo contract — never applied silently
      if (!promotionWindowOpen(promo, nowForPromo, tz)) continue;
      // Scope: which lines does this promotion cover?
      let itemIds: string[] = [];
      let categoryIds: string[] = [];
      try {
        itemIds = promo.itemIdsJson ? (JSON.parse(promo.itemIdsJson) as string[]) : [];
        categoryIds = promo.categoryIdsJson ? (JSON.parse(promo.categoryIdsJson) as string[]) : [];
      } catch {
        continue;
      }
      const eligible = lines.filter(
        (l) =>
          (itemIds.length === 0 && categoryIds.length === 0) ||
          (l.menuItemId && itemIds.includes(l.menuItemId)) ||
          (l.categoryId && categoryIds.includes(l.categoryId)),
      );
      if (eligible.length === 0) continue;
      const eligibleSubtotal = eligible.reduce((s, l) => s + l.lineSubtotalMinor, 0);
      if (eligibleSubtotal <= 0) continue;
      let promoDiscount = 0;
      if (promo.type === "PERCENT" || promo.type === "HAPPY_HOUR") {
        if (!promo.percentBps || promo.percentBps <= 0) continue;
        promoDiscount = eligible.reduce((s, l) => s + roundMinor((l.lineSubtotalMinor * promo.percentBps!) / 10_000), 0);
      } else if (promo.type === "FLAT") {
        if (!promo.valueMinor || promo.valueMinor <= 0) continue;
        promoDiscount = Math.min(promo.valueMinor, eligibleSubtotal);
      }
      if (promoDiscount <= 0) continue;
      candidates.push({ row: promo, discount: promoDiscount });
    }
    if (candidates.length === 0) return null;
    // Highest discount wins; tie → higher priority (schema contract).
    candidates.sort((a, b) => b.discount - a.discount || b.row.priority - a.row.priority);
    const best = candidates[0];
    return {
      id: best.row.id,
      name: best.row.name,
      version: best.row.version,
      label: `${best.row.name} (${best.row.type})`,
      discount: best.discount,
    };
  })();
  // Combined discount, capped so the bill can never go negative and
  // coupon + promotion together can never exceed the subtotal.
  const promotionDiscountMinor = appliedPromotion
    ? Math.min(appliedPromotion.discount, subtotalMinor - discountMinor)
    : 0;
  const totalDiscountMinor = Math.min(discountMinor + promotionDiscountMinor, subtotalMinor);

  /* ---------------- Issuing transaction (tx only) ---------------- */
  const result = await db.$transaction(
    async (tx) => {
      // AUTHORITATIVE fence: an existing non-void bill covering these orders?
      const orderIds = orders.map((o) => o.id);
      const existingLines = await tx.billLine.findMany({
        where: { bill: { hotelId, status: { not: "VOID" } }, orderId: { in: orderIds } },
        select: { orderId: true },
      });
      if (existingLines.length > 0) {
        throw new BillValidationError("One or more of these orders are already billed.", "ALREADY_BILLED");
      }

      // Inline coupon redemption (fenced in the issuing transaction so a
      // failed bill creation rolls the redemption back with it). Mirrors the
      // slot-reservation logic of redeemCoupon() with the transaction client.
      let couponRedemptionId: string | null = null;
      if (couponRow && couponCode && input.customerId) {
        const updated = await tx.coupon.update({
          where: { id: couponRow.id },
          data: {
            totalRedemptions: { increment: 1 },
            totalDiscount: { increment: discountMinor / 100 },
          },
        });
        if (updated.usageLimit > 0 && updated.totalRedemptions > updated.usageLimit) {
          throw new BillValidationError("Coupon usage limit reached just before redemption.", "COUPON_INVALID");
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const usedByCustomer = await tx.couponRedemption.count({
            where: { couponId: couponRow.id, customerId: input.customerId },
          });
          if (couponRow.customerLimit > 0 && usedByCustomer >= couponRow.customerLimit) {
            throw new BillValidationError("You have already used this coupon the maximum number of times.", "COUPON_INVALID");
          }
          try {
            const redemption = await tx.couponRedemption.create({
              data: {
                couponId: couponRow.id,
                customerId: input.customerId,
                hotelId,
                orderAmount: subtotalMinor / 100,
                discountAmount: discountMinor / 100,
                redemptionSlot: usedByCustomer,
              },
            });
            couponRedemptionId = redemption.id;
            break;
          } catch (slotErr) {
            if (
              typeof slotErr === "object" &&
              slotErr !== null &&
              "code" in slotErr &&
              (slotErr as { code?: string }).code === "P2002"
            ) {
              continue; // slot race — recompute and retry
            }
            throw slotErr;
          }
        }
        if (!couponRedemptionId) {
          throw new BillValidationError("Coupon redemption is busy — please try again.", "COUPON_INVALID");
        }
      }

      // AUDIT FIX (P14-DISC-1) + (P15-PRM-2): allocate the COMBINED discount
      // (coupon + promotion) with the largest-remainder method so the per-line
      // shares sum EXACTLY to the declared discount (no lost/invented paise,
      // no negative lines).
      const discountShares = allocateProportional(
        totalDiscountMinor,
        lines.map((l) => l.lineSubtotalMinor),
      );
      const discountedLineSubtot = lines.map((l, i) => l.lineSubtotalMinor - discountShares[i]);

      let taxMinorTotal = 0;
      const lineTax = lines.map((l, i) => {
        const lineRules = rules.filter(
          (r) =>
            r.scopeType === "ALL" ||
            (r.scopeType === "ITEM" && l.menuItemId && r.scopeIds.includes(l.menuItemId)) ||
            (r.scopeType === "CATEGORY" && l.categoryId && r.scopeIds.includes(l.categoryId)),
        );
        // AUDIT FIX (P14-TAX-1): one rule per line — most specific scope wins
        // (see pickBestRuleForLine); overlapping rules never stack.
        const lineRule = pickBestRuleForLine(lineRules);
        const taxed = taxForLine(discountedLineSubtot[i], lineRule ? [lineRule] : []);
        taxMinorTotal += taxed.taxMinor;
        return taxed;
      });

      const totalMinor = lines.reduce((s, l, i) => s + lineTax[i].lineTotalMinor, 0);

      const { series, seqNumber, billNumber } = await nextInvoiceNumber(tx, hotelId, new Date());

      const bill = await tx.bill.create({
        data: {
          hotelId,
          billNumber,
          series,
          seqNumber,
          status: "ISSUED",
          tableSessionId: input.tableSessionId ?? orders[0].tableSessionId ?? null,
          tableId: orders[0].tableId ?? null,
          currency: orders[0].currency,
          subtotalMinor,
          discountMinor: totalDiscountMinor,
          taxMinor: taxMinorTotal,
          totalMinor,
          // AUDIT FIX (P15-PRM-2): frozen promotion snapshot (version + label)
          // — later promotion edits can never alter an issued invoice.
          ...(appliedPromotion
            ? { promotionId: appliedPromotion.id, promotionVersion: appliedPromotion.version, promotionLabel: appliedPromotion.label }
            : {}),
          couponCode,
          couponRedemptionId,
          discountReason,
          discountByUserId,
          customerId: input.customerId ?? null,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          taxSnapshot: JSON.stringify(lineTax.flatMap((t) => t.appliedRules)),
          legalSnapshot: JSON.stringify({
            hotelName: hotel?.name ?? "",
            address: hotel?.address ?? "",
            city: hotel?.city ?? "",
            state: hotel?.state ?? "",
            gstin: hotel?.gstin ?? "",
            phone: hotel?.phone ?? "",
          }),
          notes: input.notes ?? null,
          issuedByUserId,
          idempotencyKey: input.idempotencyKey ?? null,
          lines: {
            create: lines.map((l, i) => ({
              orderId: l.orderId,
              orderItemId: l.orderItemId,
              nameSnapshot: l.nameSnapshot,
              quantity: l.quantity,
              unitPriceMinor: l.unitPriceMinor,
              lineSubtotalMinor: l.lineSubtotalMinor,
              // Per-line allocated discount (largest-remainder conserves total).
              discountMinor: l.lineSubtotalMinor - discountedLineSubtot[i],
              taxableMinor: lineTax[i].taxableMinor,
              taxMinor: lineTax[i].taxMinor,
              lineTotalMinor: lineTax[i].taxableMinor + lineTax[i].taxMinor,
              taxBreakup: JSON.stringify(lineTax[i].taxBreakup),
            })),
          },
        },
        select: { id: true, billNumber: true, totalMinor: true, currency: true },
      });

      await logAudit({
        hotelId,
        userId: issuedByUserId,
        action: "BILL_ISSUED",
        entityType: "Bill",
        entityId: bill.id,
        metadata: { billNumber, subtotalMinor, discountMinor: totalDiscountMinor, promotion: appliedPromotion?.label ?? null, taxMinor: taxMinorTotal, totalMinor },
        tx,
      });

      return bill;
    },
    { timeout: 30_000, maxWait: 10_000 },
  ).catch(async (err) => {
    // AUDIT FIX (P14-IDEM-1): a concurrent create with the SAME idempotency
    // key surfaced as an unhandled P2002 (500). Bill.idempotencyKey is the
    // DB fence — on a race, return the bill the winner created instead.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002" &&
      input.idempotencyKey
    ) {
      const winner = await db.bill.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner && winner.hotelId === hotelId) {
        return { id: winner.id, billNumber: winner.billNumber, totalMinor: winner.totalMinor, currency: winner.currency };
      }
    }
    throw err;
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export interface RecordPaymentInput {
  hotelId: string;
  billId: string;
  recordedByUserId: string;
  method: "CASH" | "UPI" | "CARD" | "ONLINE" | "OTHER";
  amountMinor: number;
  reference?: string | null;
  cashSessionId?: string | null;
  idempotencyKey?: string | null;
}

export interface PaymentResult {
  ok: boolean;
  reason?: string;
  billId: string;
  status: string;
  paidMinor: number;
  billStatus: string;
  paymentId?: string;
}

/**
 * Record a MANUAL payment allocation (cash/UPI/card typed in by the cashier —
 * explicitly labelled "manually recorded", never gateway-verified). When the
 * bill becomes fully paid, the paid-completion side effects run exactly once.
 *
 * AUDIT FIX (P14-PAY-1): the previous implementation read the bill BEFORE the
 * transaction and wrote `paidMinor = staleRead + amount` inside it, so two
 * concurrent pays could both pass the due check and lose an allocation (or
 * exceed the total). The transaction now re-reads the bill AUTHORITATIVELY,
 * re-validates the due amount on fresh data, and flips the status with a
 * conditional update. The RESTAURANT_BILL_PAID outbox job is created INSIDE
 * the same transaction (transactional outbox — exactly-once by commit).
 */
export async function recordManualPayment(input: RecordPaymentInput): Promise<PaymentResult> {
  const fail = (reason: string, billStatus = "FAILED", paidMinor = 0): PaymentResult => ({
    ok: false,
    reason,
    billId: input.billId,
    status: "FAILED",
    paidMinor,
    billStatus,
  });

  // Fast pre-checks (non-authoritative — the transaction re-validates).
  const bill = await db.bill.findFirst({ where: { id: input.billId, hotelId: input.hotelId } });
  if (!bill) return fail("Bill not found.", "NOT_FOUND");
  if (input.amountMinor <= 0) return fail("Payment amount must be positive.", bill.status, bill.paidMinor);

  // Hash the caller-provided key with its bill/tenant scope. This keeps raw
  // idempotency tokens out of the database and avoids substring/escaping bugs.
  const paymentIdempotencyKey = input.idempotencyKey
    ? createHash("sha256").update(JSON.stringify([input.hotelId, bill.id, input.idempotencyKey])).digest("hex")
    : null;
  const replayResult = async (existing: { id: string; status: string; method: string; amountMinor: number; reference: string | null; cashSessionId: string | null }) => {
    if (
      existing.method !== input.method ||
      existing.amountMinor !== input.amountMinor ||
      existing.reference !== (input.reference ?? null) ||
      existing.cashSessionId !== (input.cashSessionId ?? null)
    ) {
      return fail("Idempotency key has already been used for a different payment.", bill.status, bill.paidMinor);
    }
    const fresh = await db.bill.findUnique({ where: { id: bill.id } });
    return { ok: true, billId: bill.id, status: existing.status, paidMinor: fresh?.paidMinor ?? bill.paidMinor, billStatus: fresh?.status ?? bill.status, paymentId: existing.id, reason: "ALREADY_RECORDED" };
  };

  if (paymentIdempotencyKey) {
    const existing = await db.billPayment.findUnique({ where: { idempotencyKey: paymentIdempotencyKey } });
    if (existing) return replayResult(existing);

    // Read payments written before the durable key column was introduced.
    // JSON.stringify safely escapes quotes and backslashes in legacy tokens.
    const legacyMeta = JSON.stringify({ idempotencyKey: input.idempotencyKey });
    const legacy = await db.billPayment.findFirst({ where: { billId: bill.id, meta: { contains: legacyMeta } } });
    if (legacy) return replayResult(legacy);
  }

  // Replays are resolved before terminal-state checks: a retry after the bill
  // was later refunded/voided must still identify the original payment.
  if (bill.status === "VOID") return fail("Bill is void.", "VOID", bill.paidMinor);
  if (bill.status === "REFUNDED") return fail("Bill is fully refunded.", "REFUNDED", bill.paidMinor);

  // AUDIT FIX (P14-CSH-1): a payment tagged to a missing/closed/foreign cash
  // session silently vanished from every drawer reconciliation. Validate it.
  if (input.cashSessionId) {
    const session = await db.cashSession.findFirst({
      where: { id: input.cashSessionId, hotelId: input.hotelId, status: "OPEN" },
      select: { id: true },
    });
    if (!session) return fail("Cash session not found or not open.", bill.status, bill.paidMinor);
  }

  try {
    const result = await db.$transaction(
      async (tx) => {
        const fresh = await tx.bill.findFirst({ where: { id: input.billId, hotelId: input.hotelId } });
        if (!fresh) throw new BillValidationError("Bill not found.", "BILL_NOT_FOUND");
        if (fresh.status === "VOID") throw new BillValidationError("Bill is void.", "BILL_STATE");
        if (fresh.status === "REFUNDED") throw new BillValidationError("Bill is fully refunded.", "BILL_STATE");

        const due = fresh.totalMinor - fresh.paidMinor;
        if (input.amountMinor > due) {
          throw new BillValidationError(`Payment exceeds the due amount (due ${(due / 100).toFixed(2)}).`, "OVERPAYMENT");
        }

        const p = await tx.billPayment.create({
          data: {
            hotelId: input.hotelId,
            billId: fresh.id,
            method: input.method,
            source: "MANUAL",
            status: "RECORDED",
            amountMinor: input.amountMinor,
            currency: fresh.currency,
            cashSessionId: input.cashSessionId ?? null,
            reference: input.reference ?? null,
            recordedByUserId: input.recordedByUserId,
            idempotencyKey: paymentIdempotencyKey,
          },
        });
        const paidMinor = fresh.paidMinor + input.amountMinor;
        const newStatus: "PARTIALLY_PAID" | "PAID" = paidMinor >= fresh.totalMinor ? "PAID" : "PARTIALLY_PAID";
        const updated = await tx.bill.updateMany({
          where: { id: fresh.id, status: fresh.status }, // conditional flip — stale writers lose
          data: { paidMinor, status: newStatus, ...(newStatus === "PAID" ? { paidAt: new Date() } : {}) },
        });
        if (updated.count !== 1) {
          throw new BillValidationError("Bill changed during payment — please retry.", "CONFLICT");
        }
        await logAudit({
          hotelId: input.hotelId,
          userId: input.recordedByUserId,
          action: "BILL_PAYMENT_RECORDED",
          entityType: "BillPayment",
          entityId: p.id,
          metadata: { billId: fresh.id, method: input.method, amountMinor: input.amountMinor, manual: true },
          tx,
        });
        if (newStatus === "PAID") {
          // Transactional outbox: the follow-up job commits atomically with
          // the PAID flip (no window for a duplicate job or a missed one).
          await tx.backgroundJob.create({
            data: {
              hotelId: fresh.hotelId,
              type: "RESTAURANT_BILL_PAID",
              status: "QUEUED",
              payload: JSON.stringify({
                billId: fresh.id,
                hotelId: fresh.hotelId,
                customerId: fresh.customerId,
                totalMinor: fresh.totalMinor,
                currency: fresh.currency,
                billNumber: fresh.billNumber,
              }),
              createdBy: input.recordedByUserId,
            },
          });
        }
        return { payment: p, paidMinor, newStatus };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    return {
      ok: true,
      billId: input.billId,
      status: result.payment.status,
      paidMinor: result.paidMinor,
      billStatus: result.newStatus,
      paymentId: result.payment.id,
    };
  } catch (err) {
    if (
      paymentIdempotencyKey &&
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Concurrent retries can both pass the pre-check. The unique index is
      // the authoritative fence; return the committed winner instead of
      // applying a second allocation or surfacing a spurious 500.
      const winner = await db.billPayment.findUnique({ where: { idempotencyKey: paymentIdempotencyKey } });
      if (winner) return replayResult(winner);
    }
    if (err instanceof BillValidationError) {
      const fresh = await db.bill.findUnique({ where: { id: input.billId } });
      return fail(err.message, fresh?.status ?? "FAILED", fresh?.paidMinor ?? 0);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Bill-paid side effects (exactly once)                               */
/* ------------------------------------------------------------------ */

/**
 * Run the bill-completion side effects exactly once:
 *  1. Customer resolution (phone-based) + loyalty award (idempotent
 *     `earn:{billId}` — the ledger unique key prevents double award).
 *  2. Legacy restaurant visit aggregate (Phase 5 analytics compatibility).
 *  3. Durable RESTAURANT_BILL_PAID outbox job — followups (thank-you/review
 *     invites, automations, stock deduction policy hooks) run in the worker.
 */
export async function onBillPaid(billId: string): Promise<void> {
  const bill = await db.bill.findUnique({ where: { id: billId } });
  if (!bill || bill.status !== "PAID") return;

  // Re-entry guard: the durable job row IS the idempotency fence.
  const existingJob = await db.backgroundJob.findFirst({
    where: { type: "RESTAURANT_BILL_PAID", payload: { contains: `"billId":"${bill.id}"` }, status: { in: ["QUEUED", "RUNNING", "COMPLETED"] } },
  });
  if (existingJob) return;

  let customerId = bill.customerId;
  if (!customerId && bill.customerPhone) {
    const existing = await db.customer.findFirst({
      where: { hotelId: bill.hotelId, phone: bill.customerPhone },
      select: { id: true },
    });
    customerId = existing?.id ?? null;
  }

  await db.$transaction(async (tx) => {
    await tx.backgroundJob.create({
      data: {
        hotelId: bill.hotelId,
        type: "RESTAURANT_BILL_PAID",
        status: "QUEUED",
        payload: JSON.stringify({
          billId: bill.id,
          hotelId: bill.hotelId,
          customerId,
          totalMinor: bill.totalMinor,
          currency: bill.currency,
          billNumber: bill.billNumber,
        }),
        createdBy: bill.issuedByUserId,
      },
    });
  });
  // NOTE: loyalty + visit aggregates + followups run in the durable job
  // handler (runRestaurantBillPaid) — visit recording internally awards
  // loyalty idempotently, so a separate award here would double-count.
}

/* ------------------------------------------------------------------ */
/* Refunds & voids (owner-authorized)                                  */
/* ------------------------------------------------------------------ */

export interface RefundInput {
  hotelId: string;
  billId: string;
  approvedByUserId: string;
  type: "REFUND" | "VOID";
  amountMinor?: number; // for REFUND (default: remaining refundable)
  reason: string;
}

/**
 * Owner-authorized refund/void. NEVER erases issued history: refunds create
 * BillRefund rows and reduce refundable balance; a void flips status to VOID
 * keeping the bill + lines + payments for audit.
 *
 * AUDIT FIX (P14-RFD-1): refundable was computed from a stale pre-transaction
 * read and `refundMinor = stale + amount` written inside the tx — two
 * concurrent refunds could exceed the paid amount. The transaction now
 * re-reads the bill and validates on fresh data with a conditional update.
 * AUDIT FIX (P14-VOID-1): voiding a bill that still holds un-refunded
 * payments detached its money from sales reporting (paid cash left the
 * drawer unaccounted). A void now requires a clean bill (no payments, no
 * refunds); moneyed bills must go through the refund path.
 */
export async function refundOrVoidBill(input: RefundInput): Promise<{ ok: boolean; reason?: string; refundMinor?: number; status?: string }> {
  const bill = await db.bill.findFirst({ where: { id: input.billId, hotelId: input.hotelId } });
  if (!bill) return { ok: false, reason: "Bill not found." };
  if (bill.status === "VOID") return { ok: false, reason: "Bill is already void." };
  if (!input.reason || input.reason.trim().length < 3) {
    return { ok: false, reason: "A reason of at least 3 characters is required." };
  }

  if (input.type === "VOID") {
    if (bill.refundMinor > 0) return { ok: false, reason: "Refunded bills cannot be voided; use a refund." };
    if (bill.paidMinor > 0) {
      return { ok: false, reason: "This bill has payments recorded — use a refund instead of a void." };
    }
    try {
      await db.$transaction(
        async (tx) => {
          const updated = await tx.bill.updateMany({
            where: { id: bill.id, status: bill.status }, // conditional flip
            data: { status: "VOID", voidedAt: new Date(), voidReason: input.reason },
          });
          if (updated.count !== 1) throw new BillValidationError("Bill changed during void — please retry.", "CONFLICT");
          await logAudit({
            hotelId: input.hotelId,
            userId: input.approvedByUserId,
            action: "BILL_VOIDED",
            entityType: "Bill",
            entityId: bill.id,
            metadata: { billNumber: bill.billNumber, reason: input.reason, totalMinor: bill.totalMinor },
            tx,
          });
        },
        { timeout: 30_000 },
      );
    } catch (err) {
      if (err instanceof BillValidationError) return { ok: false, reason: err.message };
      throw err;
    }
    return { ok: true, status: "VOID", refundMinor: 0 };
  }

  // REFUND — cannot exceed paid minus already refunded. Amount is validated
  // AGAIN inside the transaction against fresh data (concurrent refunds).
  const refundable = bill.paidMinor - bill.refundMinor;
  const amount = input.amountMinor ?? refundable;
  if (amount <= 0) return { ok: false, reason: "Nothing left to refund on this bill." };
  if (amount > refundable) return { ok: false, reason: `Refund exceeds the refundable amount (${(refundable / 100).toFixed(2)}).` };

  let finalStatus: "PARTIALLY_REFUNDED" | "REFUNDED";
  try {
    finalStatus = await db.$transaction(
      async (tx) => {
        const fresh = await tx.bill.findFirst({ where: { id: bill.id, hotelId: input.hotelId } });
        if (!fresh || fresh.status === "VOID") throw new BillValidationError("Bill is void.", "BILL_STATE");
        const freshRefundable = fresh.paidMinor - fresh.refundMinor;
        if (amount > freshRefundable) {
          throw new BillValidationError(`Refund exceeds the refundable amount (${(freshRefundable / 100).toFixed(2)}).`, "OVER_REFUND");
        }
        await tx.billRefund.create({
          data: {
            hotelId: input.hotelId,
            billId: bill.id,
            type: "REFUND",
            amountMinor: amount,
            currency: fresh.currency,
            reason: input.reason,
            mode: "MANUAL",
            approvedByUserId: input.approvedByUserId,
          },
        });
        const refundMinor = fresh.refundMinor + amount;
        const status: "PARTIALLY_REFUNDED" | "REFUNDED" = refundMinor >= fresh.paidMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
        const updated = await tx.bill.updateMany({
          where: { id: bill.id, status: fresh.status }, // conditional flip
          data: { refundMinor, status },
        });
        if (updated.count !== 1) throw new BillValidationError("Bill changed during refund — please retry.", "CONFLICT");
        await logAudit({
          hotelId: input.hotelId,
          userId: input.approvedByUserId,
          action: "BILL_REFUNDED",
          entityType: "BillRefund",
          entityId: bill.id,
          metadata: { billNumber: bill.billNumber, amountMinor: amount, reason: input.reason },
          tx,
        });
        return status;
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof BillValidationError) return { ok: false, reason: err.message };
    throw err;
  }
  return { ok: true, refundMinor: amount, status: finalStatus };
}

/* ------------------------------------------------------------------ */
/* Cash sessions                                                       */
/* ------------------------------------------------------------------ */

export async function openCashSession(hotelId: string, userId: string, openingFloatMinor: number): Promise<{ ok: boolean; reason?: string; id?: string }> {
  const open = await db.cashSession.findFirst({ where: { hotelId, status: "OPEN" } });
  if (open) return { ok: false, reason: "A cash session is already open." };
  const created = await db.cashSession
    .create({ data: { hotelId, status: "OPEN", openFence: 1, openingFloatMinor: Math.max(0, Math.floor(openingFloatMinor)), openedByUserId: userId } })
    .catch(() => null); // openFence unique → another worker opened first
  if (!created) return { ok: false, reason: "A cash session is already open." };
  await logAudit({ hotelId, userId, action: "CASH_SESSION_OPENED", entityType: "CashSession", entityId: created.id, metadata: { openingFloatMinor } });
  return { ok: true, id: created.id };
}

export async function closeCashSession(hotelId: string, userId: string, sessionId: string, countedCashMinor: number, notes?: string) {
  const session = await db.cashSession.findFirst({ where: { id: sessionId, hotelId, status: "OPEN" } });
  if (!session) return { ok: false as const, reason: "Open cash session not found." };

  // AUDIT FIX (P14-CSH-2): closing a drawer over bills that still hold
  // session-tagged money made the reconciliation silently incomplete. Bills
  // with a payment in THIS session must be settled (PAID/REFUNDED) first.
  const pendingBills = await db.bill.findMany({
    where: {
      hotelId,
      status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      payments: { some: { cashSessionId: sessionId } },
    },
    select: { billNumber: true, status: true },
    take: 10,
  });
  if (pendingBills.length > 0) {
    return {
      ok: false as const,
      reason: `Cannot close — ${pendingBills.length} bill(s) paid through this drawer are still unsettled (e.g. ${pendingBills[0].billNumber}). Settle or refund them first.`,
      pendingBillNumbers: pendingBills.map((b) => b.billNumber),
    };
  }

  const payments = await db.billPayment.findMany({
    where: { hotelId, cashSessionId: sessionId, status: { in: ["RECORDED", "CAPTURED"] } },
  });
  const refunds = await db.billRefund.findMany({
    where: { hotelId, bill: { hotelId }, createdAt: { gte: session.openedAt, lte: new Date() }, mode: "MANUAL" },
  });
  const cashSales = payments.filter((p) => p.method === "CASH").reduce((s, p) => s + p.amountMinor, 0);
  const refundMinor = refunds.reduce((s, r) => s + r.amountMinor, 0);
  const expected = session.openingFloatMinor + cashSales - refundMinor;

  const closed = await db.cashSession.updateMany({
    where: { id: sessionId, status: "OPEN" }, // conditional close — concurrent close loses
    data: {
      status: "CLOSED",
      openFence: null,
      cashSalesMinor: cashSales,
      refundMinor,
      expectedCashMinor: expected,
      countedCashMinor,
      varianceMinor: countedCashMinor - expected,
      closedByUserId: userId,
      closedAt: new Date(),
      notes: notes ?? session.notes,
    },
  });
  if (closed.count !== 1) return { ok: false as const, reason: "Cash session was just closed by someone else." };
  await logAudit({
    hotelId,
    userId,
    action: "CASH_SESSION_CLOSED",
    entityType: "CashSession",
    entityId: sessionId,
    metadata: { cashSalesMinor: cashSales, refundMinor, expectedCashMinor: expected, countedCashMinor, varianceMinor: countedCashMinor - expected },
  });
  return { ok: true as const, cashSalesMinor: cashSales, refundMinor, expectedCashMinor: expected, varianceMinor: countedCashMinor - expected };
}

/* ------------------------------------------------------------------ */
/* Razorpay restaurant gateway (SEPARATE from SaaS subscription domain) */
/* ------------------------------------------------------------------ */

export function restaurantPaymentSignature(orderId: string, paymentId: string, keySecret: string): string {
  return createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
}

export function verifyGatewaySignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  const expected = Buffer.from(restaurantPaymentSignature(orderId, paymentId, keySecret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Resolves the tenant's RAZORPAY integration (restaurant collection account). */
export async function restaurantGatewayCredentials(hotelId: string): Promise<{ keyId: string; keySecret: string } | null> {
  const integration = await db.integration.findFirst({
    where: { hotelId, type: "RAZORPAY", enabled: true, status: "CONNECTED" },
  });
  if (!integration?.credentials) return null;
  try {
    const { decryptCredentials } = await import("@/lib/crypto");
    const creds = decryptCredentials({ hotelId, integrationType: "RAZORPAY" }, integration.credentials) as Record<string, unknown>;
    const keyId = String(creds.key_id ?? creds.keyId ?? "");
    const keySecret = String(creds.key_secret ?? creds.keySecret ?? "");
    if (keyId && keySecret) return { keyId, keySecret };
    return null;
  } catch {
    return null;
  }
}

/** 32-char url-safe token for payment links (same entropy as QR codes). */
export function newPaymentLinkToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Allocate a gateway capture to a bill. Idempotent by gatewayPaymentId
 * (DB unique fence): duplicate verifications/webhooks can never double-pay.
 * The intent row (status FAILED, kind ORDER_INTENT) is upgraded in place.
 */
export async function recordGatewayCapture(params: {
  hotelId: string;
  intentPaymentId: string;
  gatewayOrderId: string;
  gatewayPaymentId: string;
  expectedAmountMinor: number;
}): Promise<{ ok: boolean; reason?: string; billStatus?: string; paidMinor?: number }> {
  try {
    const outcome = await db.$transaction(
      async (tx) => {
        const intent = await tx.billPayment.findUnique({ where: { id: params.intentPaymentId } });
        if (!intent || intent.hotelId !== params.hotelId) {
          return { ok: false as const, reason: "Intent not found." };
        }
        if (intent.status === "CAPTURED") {
          return { ok: true as const, duplicate: true, billId: intent.billId };
        }
        if (intent.amountMinor !== params.expectedAmountMinor) {
          return { ok: false as const, reason: "Amount mismatch between intent and verification." };
        }
        const bill = await tx.bill.findUnique({ where: { id: intent.billId } });
        if (!bill || bill.hotelId !== params.hotelId) {
          return { ok: false as const, reason: "Bill not found." };
        }
        if (["VOID", "REFUNDED"].includes(bill.status)) {
          return { ok: false as const, reason: `Bill is ${bill.status.toLowerCase()}.` };
        }
        // AUDIT FIX (P14-GWY-1): a capture may never push paidMinor above
        // totalMinor (two live intents, or a capture racing a manual pay,
        // previously created refundable phantom credit). Over-allocation is
        // rejected — the gateway side must refund the excess.
        if (intent.amountMinor > bill.totalMinor - bill.paidMinor) {
          return { ok: false as const, reason: "Capture exceeds the amount still due on this bill." };
        }

        await tx.billPayment.update({
          where: { id: intent.id },
          data: {
            status: "CAPTURED",
            gatewayPaymentId: params.gatewayPaymentId, // unique fence — P2002 if replayed
            signatureVerified: true,
          },
        });
        const paidMinor = bill.paidMinor + intent.amountMinor;
        const status: "PARTIALLY_PAID" | "PAID" = paidMinor >= bill.totalMinor ? "PAID" : "PARTIALLY_PAID";
        const billFlip = await tx.bill.updateMany({
          where: { id: bill.id, status: bill.status }, // conditional flip — a concurrent manual pay wins instead
          data: { paidMinor, status, ...(status === "PAID" ? { paidAt: new Date() } : {}) },
        });
        if (billFlip.count !== 1) {
          throw new BillValidationError("Bill changed during capture — reconcile and retry.", "CONFLICT");
        }
        if (status === "PAID") {
          // Transactional outbox — identical fence to recordManualPayment.
          await tx.backgroundJob.create({
            data: {
              hotelId: bill.hotelId,
              type: "RESTAURANT_BILL_PAID",
              status: "QUEUED",
              payload: JSON.stringify({
                billId: bill.id,
                hotelId: bill.hotelId,
                customerId: bill.customerId,
                totalMinor: bill.totalMinor,
                currency: bill.currency,
                billNumber: bill.billNumber,
              }),
              createdBy: null,
            },
          });
        }
        await logAudit({
          hotelId: params.hotelId,
          userId: null,
          action: "BILL_PAYMENT_CAPTURED",
          entityType: "BillPayment",
          entityId: intent.id,
          metadata: { billId: bill.id, gateway: "RAZORPAY", gatewayPaymentId: params.gatewayPaymentId, amountMinor: intent.amountMinor, verified: true },
          tx,
        });
        return { ok: true as const, duplicate: false, billId: bill.id, billStatus: status, paidMinor };
      },
      { timeout: 30_000 },
    );

    if (outcome.ok && !outcome.duplicate && outcome.billStatus === "PAID") {
      await onBillPaid(outcome.billId);
    }
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return { ok: true, billStatus: outcome.billStatus, paidMinor: outcome.paidMinor };
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      // Concurrent capture/webhook already allocated this payment.
      return { ok: true };
    }
    throw err;
  }
}
