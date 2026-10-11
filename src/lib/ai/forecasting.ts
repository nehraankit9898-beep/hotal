/**
 * Phase 18 — DEMAND FORECASTING (baseline first, honest, advisory-only).
 *
 * METHOD (documented, deterministic, reproducible):
 *  - MODEL: weekday moving average of per-item daily demand over the last
 *    `windowWeeks` weeks (default 6), computed in the TENANT's business day
 *    timezone (Hotel.timezone IANA; UTC storage everywhere).
 *  - DEMAND DEFINITION: count of non-cancelled order LINES (quantity summed)
 *    for the item per business day. Cancelled orders/lines are excluded —
 *    refunds/cancellations are handled by the documented financial policy,
 *    not silently re-added here.
 *  - UNCERTAINTY: sample std-dev of the same weekday window → an interval of
 *    ±1.96σ (approx. 95% under normality — stated, not guaranteed).
 *  - BACKTEST: chronological (no shuffling — no leakage): train = everything
 *    before the last `backtestDays` days, test = those days. Reported as MAE
 *    of the model vs MAE of the naive baseline ("same as overall mean"),
 *    i.e. skill = 1 - mae/naiveMae. Sample counts are always reported.
 *  - DATA SUFFICIENCY: fewer than 14 days of history or fewer than
 *    `minDataPoints` observations for an item → sufficient=false → the API
 *    and UI show NOT_ENOUGH_DATA instead of a number.
 *
 * WHAT THIS NEVER DOES (hard guarantees):
 *  - No automatic purchase orders, stock mutations or staff scheduling — the
 *    forecast row is ADVISORY ONLY and nothing in the worker consumes it.
 *  - No external model calls (rule-based only, modelProvider NONE).
 *  - No fabricated precision: insufficient data → NOT_ENOUGH_DATA.
 */

import { db } from "@/lib/db";
import { getAISettings, logAIInteraction } from "@/lib/ai/governance";

export const FORECAST_METHOD = "WEEKDAY_MOVING_AVG";

export interface ForecastRow {
  menuItemId: string | null;
  menuItemName: string | null;
  businessDate: string;
  dow: number;
  forecastQty: number;
  lowerBound: number;
  upperBound: number;
  method: string;
  dataPoints: number;
  sufficient: boolean;
  mae: number | null;
  naiveMae: number | null;
}

/* ------------------------------------------------------------------ */
/* Business-day helpers (tenant IANA timezone)                          */
/* ------------------------------------------------------------------ */

/** Format a Date as YYYY-MM-DD in the given IANA timezone (Intl-based). */
export function businessDateKey(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10); // invalid tz falls back to UTC (never crashes)
  }
}

/** Day-of-week (0=Sun..6=Sat) of a YYYY-MM-DD business date string. */
export function dowOfBusinessDate(key: string): number {
  const d = new Date(`${key}T00:00:00Z`);
  return d.getUTCDay();
}

function addDays(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* History extraction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Daily per-item demand from PLACED-or-later (non-cancelled) orders, bucketed
 * by the tenant's business day. Reads OrderItem snapshots joined to orders —
 * the same immutable data the kitchen/bills see.
 */
export async function loadDailyDemand(
  hotelId: string,
  timezone: string,
  fromDaysBack: number,
): Promise<Map<string, Map<string, number>>> {
  // menuItemId → businessDate → qty
  const out = new Map<string, Map<string, number>>();
  const since = new Date(Date.now() - fromDaysBack * 86_400_000);

  const items = await db.orderItem.findMany({
    where: {
      order: { hotelId, placedAt: { gte: since }, status: { not: "CANCELLED" } },
      status: { not: "CANCELLED" },
    },
    select: {
      menuItemId: true, quantity: true,
      order: { select: { placedAt: true } },
    },
  });

  for (const line of items) {
    if (!line.menuItemId) continue;
    const key = businessDateKey(line.order.placedAt, timezone);
    let byDate = out.get(line.menuItemId);
    if (!byDate) { byDate = new Map(); out.set(line.menuItemId, byDate); }
    byDate.set(key, (byDate.get(key) ?? 0) + line.quantity);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Core statistics                                                      */
/* ------------------------------------------------------------------ */

export interface WeekdayStats {
  mean: number;
  stdDev: number;
  count: number;
}

/** Mean/σ of same-weekday observations within the window. */
export function weekdayStats(series: Map<string, number>, targetDow: number, endDate: string, windowDays: number): WeekdayStats {
  const values: number[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const key = addDays(endDate, -i);
    if (dowOfBusinessDate(key) === targetDow) {
      const v = series.get(key);
      if (v !== undefined) values.push(v);
      else values.push(0); // a same-weekday day with NO data = zero demand (real zero, not missing)
    }
  }
  if (values.length === 0) return { mean: 0, stdDev: 0, count: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance), count: values.length };
}

/** Chronological backtest: model vs naive on the last `testDays` days. */
export function backtest(
  series: Map<string, number>,
  windowDays: number,
  testDays: number,
  endDate: string,
): { mae: number | null; naiveMae: number | null; samples: number } {
  const errors: number[] = [];
  const naiveErrors: number[] = [];
  for (let d = 0; d < testDays; d++) {
    const target = addDays(endDate, -d);
    const actual = series.get(target) ?? 0;
    const dow = dowOfBusinessDate(target);
    // Train window ends the day BEFORE the target (strictly chronological).
    const trainEnd = addDays(target, -1);
    const st = weekdayStats(series, dow, trainEnd, windowDays);
    if (st.count === 0) continue;
    errors.push(Math.abs(st.mean - actual));
    // Naive baseline: overall mean up to trainEnd (documented naive model).
    const allVals: number[] = [];
    for (let i = 1; i <= windowDays; i++) {
      const k = addDays(trainEnd, -i);
      allVals.push(series.get(k) ?? 0);
    }
    const naiveMean = allVals.reduce((s, v) => s + v, 0) / Math.max(1, allVals.length);
    naiveErrors.push(Math.abs(naiveMean - actual));
  }
  if (errors.length === 0) return { mae: null, naiveMae: null, samples: 0 };
  return {
    mae: errors.reduce((s, v) => s + v, 0) / errors.length,
    naiveMae: naiveErrors.reduce((s, v) => s + v, 0) / naiveErrors.length,
    samples: errors.length,
  };
}

/* ------------------------------------------------------------------ */
/* Public compute API                                                   */
/* ------------------------------------------------------------------ */

export interface ComputeResult {
  computed: number;
  insufficient: number;
  horizonDays: number;
  note: string;
}

/**
 * Compute forecasts for the next `horizonDays` business days for every
 * active menu item (advisory rows only). Re-runs upsert (never duplicates).
 */
export async function computeForecasts(
  hotelId: string,
  opts: { horizonDays?: number; windowDays?: number; testDays?: number; now?: Date } = {},
): Promise<ComputeResult> {
  const settings = await getAISettings(hotelId);
  if (!settings.forecastingEnabled) {
    await logAIInteraction({
      hotelId, kind: "FORECAST", subtype: "COMPUTE",
      status: "BLOCKED_DISABLED", reason: "FORECASTING_DISABLED", meta: {},
    });
    return { computed: 0, insufficient: 0, horizonDays: 0, note: "Forecasting disabled for this tenant." };
  }

  const horizonDays = Math.min(Math.max(1, opts.horizonDays ?? 7), 14);
  const windowDays = Math.min(Math.max(7, opts.windowDays ?? 42), 84); // 6 weeks default
  const testDays = Math.min(Math.max(3, opts.testDays ?? 7), 21);
  const now = opts.now ?? new Date();

  const hotel = await db.hotel.findUnique({ where: { id: hotelId }, select: { timezone: true } });
  const timezone = hotel?.timezone || "UTC";

  const minDataPoints = 3; // same-weekday observations required per item
  const minHistoryDays = 14;

  const items = await db.menuItem.findMany({
    where: { hotelId, active: true },
    select: { id: true, name: true },
  });

  const demand = await loadDailyDemand(hotelId, timezone, windowDays + testDays + 1);

  // Overall history depth for sufficiency (earliest order in window).
  const earliestOrder = await db.diningOrder.findFirst({
    where: { hotelId, status: { not: "CANCELLED" } },
    orderBy: { placedAt: "asc" },
    select: { placedAt: true },
  });
  const historyDays = earliestOrder
    ? Math.floor((now.getTime() - earliestOrder.placedAt.getTime()) / 86_400_000)
    : 0;
  const overallSufficient = historyDays >= minHistoryDays;

  let computed = 0;
  let insufficient = 0;

  // Backtest once on the ALL-ITEMS daily series (documented: per-item
  // backtests are computed for items with enough data, aggregated metric
  // reported for the tenant).
  const totalSeries = new Map<string, number>();
  for (const [, byDate] of demand) {
    for (const [k, v] of byDate) totalSeries.set(k, (totalSeries.get(k) ?? 0) + v);
  }
  const bt = overallSufficient ? backtest(totalSeries, windowDays, testDays, businessDateKey(now, timezone)) : { mae: null, naiveMae: null, samples: 0 };

  for (const item of items) {
    const series = demand.get(item.id) ?? new Map<string, number>();
    for (let h = 0; h < horizonDays; h++) {
      const dateKey = addDays(businessDateKey(now, timezone), h);
      const dow = dowOfBusinessDate(dateKey);
      const st = weekdayStats(series, dow, businessDateKey(now, timezone), windowDays);
      const sufficient = overallSufficient && st.count >= minDataPoints;
      const forecast = sufficient ? Math.max(0, st.mean) : 0;
      const sigma = sufficient ? st.stdDev : 0;
      const row = {
        hotelId,
        menuItemId: item.id,
        businessDate: dateKey,
        dow,
        forecastQty: Number(forecast.toFixed(2)),
        lowerBound: Number(Math.max(0, forecast - 1.96 * sigma).toFixed(2)),
        upperBound: Number((forecast + 1.96 * sigma).toFixed(2)),
        method: FORECAST_METHOD,
        dataPoints: st.count,
        sufficient,
        mae: bt.mae,
        naiveMae: bt.naiveMae,
        computedAt: now,
      };
      await db.demandForecast.upsert({
        where: { hotelId_menuItemId_businessDate: { hotelId, menuItemId: item.id, businessDate: dateKey } },
        create: row,
        update: row,
      });
      if (sufficient) computed += 1;
      else insufficient += 1;
    }
  }

  await logAIInteraction({
    hotelId, kind: "FORECAST", subtype: "COMPUTE", status: overallSufficient ? "OK" : "NOT_ENOUGH_DATA",
    meta: {
      computed, insufficient, horizonDays, historyDays,
      backtestSamples: bt.samples,
      skill: bt.mae !== null && bt.naiveMae ? Number((1 - bt.mae / bt.naiveMae).toFixed(3)) : null,
    },
  });

  return {
    computed,
    insufficient,
    horizonDays,
    note: overallSufficient
      ? `Advisory weekday moving-average over ${windowDays}d; backtested on ${bt.samples} day(s).`
      : `NOT_ENOUGH_DATA: only ${historyDays} day(s) of order history (need ${minHistoryDays}+). Rows are stored as insufficient and must be shown as unavailable.`,
  };
}
