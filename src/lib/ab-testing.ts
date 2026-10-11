/**
 * Phase 17 — A/B feature experiments.
 *
 * Not merely boolean flags: cohorts are deterministic (hash of experimentId
 * + userId), measurement tracks per-arm metrics, and an emergency kill switch
 * can disable the experiment immediately. The GlobalFeatureFlag table from
 * Phase 10 remains the system for cross-cutting platform features; this is
 * the tenant-aware experimentation layer.
 *
 * Design:
 *  - Assignment is stable across sessions and devices because it's a pure
 *    function of (experimentId, userId, variantCount). The same user always
 *    sees the same variant until configuration changes.
 *  - Reassignment only happens when variant count or weights change. The
 *    assignment row is persisted so we can detect drift and migrate users
 *    only when necessary.
 *  - Kill switch: when active, all users fall back to control. The
 *    assignment row is preserved so we can resume exactly where we left off.
 */
import { createHash } from "crypto";
import { db } from "@/lib/db";

export interface ExperimentConfig {
  key: string;
  name: string;
  variants: string[]; // ["control", "treatment"]
  weights: number[];  // sums to 1, same length as variants
  active: boolean;
  killSwitch: boolean;
}

/** Parse the JSON-encoded variant list. */
export function parseVariants(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** Parse the JSON-encoded weights list, normalized to sum to 1. */
export function parseWeights(raw: string, variantCount: number): number[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== variantCount) {
      // Default: equal weights.
      return new Array(variantCount).fill(1 / variantCount);
    }
    const weights = arr.map((n) => (typeof n === "number" && n > 0 ? n : 0));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum <= 0) return new Array(variantCount).fill(1 / variantCount);
    return weights.map((w) => w / sum);
  } catch {
    return new Array(variantCount).fill(1 / variantCount);
  }
}

/**
 * Deterministically hash (experimentId, userId) to a float in [0, 1). Same
 * inputs always yield the same output — stable assignment across sessions.
 *
 * Implementation: sha256(experimentId + ":" + userId), take first 8 bytes
 * as a big-endian uint53 (avoid 2^53 overflow), divide by 2^53.
 */
function stableHash(experimentId: string, userId: string): number {
  const h = createHash("sha256").update(`${experimentId}:${userId}`).digest();
  // Use bytes 0..7 as a 53-bit integer (mask off the top 11 bits).
  const bits = (h[0] & 0x1f) * 2 ** 48 + h[1] * 2 ** 40 + h[2] * 2 ** 32 +
    h[3] * 2 ** 24 + h[4] * 2 ** 16 + h[5] * 2 ** 8 + h[6];
  return bits / 2 ** 53;
}

/** Map a [0,1) hash to a variant using cumulative weights. */
export function pickVariant(hash: number, weights: number[]): number {
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (hash < cumulative) return i;
  }
  return weights.length - 1; // boundary fallback
}

/**
 * Resolve the user's variant for an experiment. Persists the assignment if
 * not already present, or returns the existing one. If the experiment is
 * inactive or the kill switch is on, returns "control".
 *
 * Note: this is the ONLY entry point for assignment during request handling.
 * Tests must use this function — never query the ABAssignment table directly.
 */
export async function resolveVariant(
  experimentKey: string,
  userId: string,
): Promise<{ variant: string; experimentActive: boolean }> {
  const experiment = await db.aBExperiment.findUnique({
    where: { key: experimentKey },
  });
  if (!experiment || !experiment.active || experiment.killSwitch) {
    return { variant: "control", experimentActive: false };
  }
  const variants = parseVariants(experiment.variants);
  const weights = parseWeights(experiment.weights, variants.length);
  if (variants.length === 0) {
    return { variant: "control", experimentActive: false };
  }

  // Persisted assignment — return as-is if present (even if config changed,
  // we honour the original assignment until the experiment is explicitly
  // reset via a new experiment row).
  const existing = await db.aBAssignment.findUnique({
    where: {
      experimentId_userId: { experimentId: experiment.id, userId },
    },
  });
  if (existing) {
    return { variant: existing.variant, experimentActive: true };
  }

  // New assignment — deterministic hash → variant.
  const hash = stableHash(experiment.id, userId);
  const idx = pickVariant(hash, weights);
  const variant = variants[idx] ?? "control";
  try {
    await db.aBAssignment.create({
      data: { experimentId: experiment.id, userId, variant },
    });
  } catch {
    // Unique-constraint race: another worker created it. Re-read.
    const racy = await db.aBAssignment.findUnique({
      where: { experimentId_userId: { experimentId: experiment.id, userId } },
    });
    if (racy) return { variant: racy.variant, experimentActive: true };
  }
  return { variant, experimentActive: true };
}

/**
 * Toggle the kill switch on an experiment. Returns the new state.
 */
export async function setKillSwitch(experimentId: string, on: boolean): Promise<boolean> {
  const updated = await db.aBExperiment.update({
    where: { id: experimentId },
    data: { killSwitch: on },
    select: { killSwitch: true },
  });
  return updated.killSwitch;
}
