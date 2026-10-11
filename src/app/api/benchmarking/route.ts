/**
 * Phase 17 — Competitor benchmarking API.
 * GET  /api/benchmarking                → list benchmarks (honest disclosure)
 * POST /api/benchmarking                → record a benchmark (source-disclosed)
 */
import { NextResponse } from "next/server";
import { requireAuth, jsonError, jsonOk, serverError, readJson } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { recordBenchmark, getBenchmarks, getMetricAverage } from "@/lib/benchmarking";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BENCHMARK_READ");
    if (denied) return denied;
    const url = new URL(req.url);
    const metricKey = url.searchParams.get("metricKey") ?? undefined;
    const benchmarks = await getBenchmarks(auth.user.hotelId, metricKey);
    // If a metricKey is given, also compute the honest average (with sample size).
    if (metricKey) {
      const avg = await getMetricAverage(auth.user.hotelId, metricKey);
      return jsonOk({ benchmarks, average: avg });
    }
    return jsonOk({ benchmarks });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "BENCHMARK_READ");
    if (denied) return denied;
    const body = await readJson(req);
    if (!body) return jsonError("Invalid JSON body.", 422, "INVALID_BODY");
    const source = typeof body.source === "string" ? body.source : "";
    const metricKey = typeof body.metricKey === "string" ? body.metricKey : "";
    const metricValue = typeof body.metricValue === "number" ? body.metricValue : NaN;
    if (!source || !metricKey || !isFinite(metricValue) || metricValue < 0) {
      return jsonError("source, metricKey, and a non-negative metricValue are required.", 422, "VALIDATION_ERROR");
    }
    const result = await recordBenchmark(auth.user, {
      source: source as "PUBLIC_LICENSED" | "OWNER_REPORTED" | "PARTNER_API",
      metricKey,
      metricValue,
      confidence: typeof body.confidence === "string" ? body.confidence as "LOW" | "MEDIUM" | "HIGH" : undefined,
      coverageNote: typeof body.coverageNote === "string" ? body.coverageNote : undefined,
      observedAt: typeof body.observedAt === "string" ? new Date(body.observedAt) : undefined,
    });
    if (!result.ok) return jsonError(result.error, result.status ?? 400, "BENCHMARK_ERROR");
    return jsonOk({ id: result.id }, 201);
  } catch (e) {
    return serverError(e);
  }
}
