/**
 * Phase 17 — Currency & benchmarking.
 *
 * Currency per financial record; formatting/rounding/decimal precision,
 * same-currency totals and conversions using dated rates only if needed.
 * We do NOT aggregate mixed currencies blindly. Historical invoice currency
 * is immutable.
 *
 * Competitor benchmarking: only from licensed/public/authorized sources with
 * source/date/coverage/confidence disclosed. No neighbourhood averages
 * without representative data; insufficient data shown explicitly. No
 * competitor scraping or fabricated metrics.
 */
import { db } from "@/lib/db";
import type { AuthedUser } from "@/lib/api-helpers";

/**
 * Get the conversion rate for a base→quote pair on a specific date. Returns
 * null if no rate is available for that date (insufficient data — never
 * fabricated).
 */
export async function getRate(base: string, quote: string, date: Date): Promise<number | null> {
  if (base === quote) return 1;
  const datedAt = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const rate = await db.currencyRate.findUnique({
    where: { base_quote_datedAt: { base, quote, datedAt } },
  });
  return rate?.rate ?? null;
}

/**
 * Convert an amount from one currency to another using the rate on a
 * specific date. Returns null if no rate is available — caller must surface
 * "insufficient data" rather than falling back to a fabricated rate.
 *
 * Rounding: result is rounded to 2 decimal places (cents/paise). The caller
 * is responsible for the integer-minor-units conversion if needed.
 */
export async function convertCurrency(
  amountMinor: number,
  from: string,
  to: string,
  date: Date,
): Promise<{ ok: true; amountMinor: number } | { ok: false; error: string }> {
  if (from === to) return { ok: true, amountMinor };
  const rate = await getRate(from, to, date);
  if (rate === null) {
    return {
      ok: false,
      error: `No exchange rate available for ${from}→${to} on ${date.toISOString().slice(0, 10)}.`,
    };
  }
  // amountMinor is in minor units (e.g. paise). We convert at the rate level.
  const converted = (amountMinor * rate);
  return { ok: true, amountMinor: Math.round(converted) };
}

/**
 * Record a competitor benchmark. Source must be one of:
 *  - PUBLIC_LICENSED   (officially licensed data feed)
 *  - OWNER_REPORTED    (tenant self-reports their own observed metrics)
 *  - PARTNER_API        (consented partner exchange)
 *
 * Scraped/unauthorized data is NOT permitted. The `source` field is
 * disclosed in every report and API response.
 */
export async function recordBenchmark(
  user: AuthedUser,
  input: {
    source: "PUBLIC_LICENSED" | "OWNER_REPORTED" | "PARTNER_API";
    metricKey: string;
    metricValue: number;
    confidence?: "LOW" | "MEDIUM" | "HIGH";
    coverageNote?: string;
    observedAt?: Date;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string; status?: number }> {
  if (user.role === "SUPER_ADMIN") {
    return { ok: false, error: "Benchmarks are tenant-owned.", status: 403 };
  }
  if (user.role !== "HOTEL_OWNER" && user.role !== "HOTEL_ADMIN" && user.role !== "HOTEL_MANAGER") {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  if (!["PUBLIC_LICENSED", "OWNER_REPORTED", "PARTNER_API"].includes(input.source)) {
    return { ok: false, error: "Invalid source. Scraped data is not accepted.", status: 422 };
  }
  if (!input.metricKey || input.metricValue < 0) {
    return { ok: false, error: "metricKey and a non-negative metricValue are required.", status: 422 };
  }
  const created = await db.competitorBenchmark.create({
    data: {
      hotelId: user.hotelId,
      source: input.source,
      metricKey: input.metricKey.slice(0, 80),
      metricValue: input.metricValue,
      confidence: input.confidence ?? "MEDIUM",
      coverageNote: input.coverageNote?.slice(0, 500) ?? null,
      observedAt: input.observedAt ?? new Date(),
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}

/**
 * Get benchmarks for a hotel with honest disclosure. If no benchmarks
 * exist, the caller must surface "no benchmark data available" — never
 * fabricate neighbourhood averages.
 */
export async function getBenchmarks(
  hotelId: string,
  metricKey?: string,
): Promise<Array<{
  id: string;
  source: string;
  metricKey: string;
  metricValue: number;
  confidence: string;
  coverageNote: string | null;
  observedAt: Date;
}>> {
  const where = metricKey ? { hotelId, metricKey } : { hotelId };
  return db.competitorBenchmark.findMany({
    where,
    orderBy: { observedAt: "desc" },
    take: 100,
    select: {
      id: true,
      source: true,
      metricKey: true,
      metricValue: true,
      confidence: true,
      coverageNote: true,
      observedAt: true,
    },
  });
}

/**
 * Compute the average of a metric across the benchmarks — but HONESTLY:
 * if fewer than 3 data points exist, return null and surface "insufficient
 * data" rather than reporting an unreliable average. Coverage notes are
 * surfaced to the caller.
 */
export async function getMetricAverage(
  hotelId: string,
  metricKey: string,
): Promise<{
  ok: boolean;
  average: number | null;
  sampleSize: number;
  coverage: string[];
}> {
  const rows = await getBenchmarks(hotelId, metricKey);
  if (rows.length < 3) {
    return { ok: false, average: null, sampleSize: rows.length, coverage: rows.map((r) => r.coverageNote ?? "") };
  }
  const sum = rows.reduce((a, r) => a + r.metricValue, 0);
  return {
    ok: true,
    average: Math.round((sum / rows.length) * 100) / 100,
    sampleSize: rows.length,
    coverage: rows.map((r) => r.coverageNote ?? ""),
  };
}
