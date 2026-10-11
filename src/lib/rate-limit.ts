/**
 * Rate limiting — Phase 7 (distributed) replacing Phase 10/7 in-process only.
 *
 * Three cooperating layers:
 *
 * 1. **Database-backed limiter** (`db AuthAttempt` + `User.failedLoginAttempts`
 *    / `lockedUntil`) — the authoritative, SHARED, persistent limiter for
 *    authentication. Works across processes and instances because every
 *    instance hits the same database.
 *
 * 2. **Redis-backed limiter** (`checkRateLimit`) — distributed, shared across
 *    all instances when REDIS_URL is configured. Atomic fixed-window counters
 *    (INCR + PEXPIRE via a Lua script). If Redis is unreachable the limiter
 *    degrades gracefully to the in-process window (fail-open for availability,
 *    documented in docs/SECURITY.md) and reports status for /api/health.
 *
 * 3. **In-process sliding-window limiter** (`slidingWindow`) — cheap per-IP
 *    damping used directly as fallback and as first-line defense. Best-effort
 *    only — never the sole control in multi-instance deployments.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 10_000;

const buckets = new Map<string, number[]>();
const lastTouch = new Map<string, number>();

function evictIfNeeded(now: number): void {
  if (buckets.size <= MAX_KEYS) return;
  // Drop the oldest quarter of keys by last touch (approximate LRU).
  const entries = [...lastTouch.entries()].sort((a, b) => a[1] - b[1]);
  const dropCount = Math.floor(MAX_KEYS / 4);
  for (let i = 0; i < dropCount && i < entries.length; i++) {
    buckets.delete(entries[i][0]);
    lastTouch.delete(entries[i][0]);
  }
  void now;
}

export interface SlidingWindowResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** In-process sliding window. key format: "<scope>:<identifier>". */
export function slidingWindow(
  key: string,
  limit: number,
  windowMs = WINDOW_MS,
): SlidingWindowResult {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (list.length >= limit) {
    const oldest = Math.min(...list);
    buckets.set(key, list);
    lastTouch.set(key, now);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  list.push(now);
  buckets.set(key, list);
  lastTouch.set(key, now);
  evictIfNeeded(now);
  return { allowed: true, remaining: Math.max(0, limit - list.length), retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------------ */
/* Phase 7 — distributed Redis limiter                                 */
/* ------------------------------------------------------------------ */

type RedisClient = {
  eval(script: string, numKeys: number, ...args: (string | number | Buffer)[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<void>;
  status: string;
};

let redisClient: RedisClient | null = null;
let redisDisabled = false; // set after repeated connection failures
let redisFailureCount = 0;
const REDIS_MAX_FAILURES = 3;

/** Lazily connect to Redis when REDIS_URL is configured. Never throws. */
async function getRedis(): Promise<RedisClient | null> {
  const url = (process.env.REDIS_URL || "").trim();
  if (!url || redisDisabled) return null;
  if (redisClient) {
    if (redisClient.status === "ready" || redisClient.status === "connecting") return redisClient;
    return null;
  }
  try {
    // Dynamic import keeps ioredis out of bundles when REDIS_URL is unset.
    const mod = await import("ioredis");
    const Redis = mod.default;
    const client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
      retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 200, 1000)),
    });
    client.on("error", () => {
      /* errors surfaced via status/health — never crash the app */
    });
    redisClient = client as unknown as RedisClient;
    return redisClient;
  } catch {
    redisDisabled = true;
    return null;
  }
}

/** Atomic fixed-window counter: INCR, set EXPIRE on first hit, return count+TTL. */
const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export type DistributedLimiterStatus = "disabled" | "connecting" | "ready" | "error";

let lastRedisStatus: DistributedLimiterStatus = "disabled";

/** Current limiter backend status — surfaced by /api/health (no values). */
export function distributedLimiterStatus(): DistributedLimiterStatus {
  return lastRedisStatus;
}

/**
 * ACTIVE Redis readiness probe for /api/health: performs a real PING with a
 * short timeout instead of reporting the status of the last rate-limit call.
 *  - "disabled": no REDIS_URL configured (per-instance limiter — documented)
 *  - "ready":    PING succeeded within 2s
 *  - "error":    unreachable/auth failed
 */
export async function redisHealthProbe(): Promise<"disabled" | "ready" | "error"> {
  const url = (process.env.REDIS_URL || "").trim();
  if (!url) return "disabled";
  try {
    const redis = await getRedis();
    if (!redis) return "error";
    const pong = await Promise.race([
      redis.ping(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    lastRedisStatus = pong === "PONG" ? "ready" : "error";
    return pong === "PONG" ? "ready" : "error";
  } catch {
    lastRedisStatus = "error";
    return "error";
  }
}

/**
 * Distributed rate limit. Uses Redis when configured; falls back to the
 * in-process sliding window when Redis is unset or unreachable (the fallback
 * is per-instance and documented as such).
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs = WINDOW_MS,
): Promise<SlidingWindowResult> {
  const redis = await getRedis();
  if (redis) {
    try {
      const res = (await redis.eval(FIXED_WINDOW_LUA, 1, `rl:${key}`, String(windowMs))) as
        [number, number] | unknown;
      lastRedisStatus = "ready";
      redisFailureCount = 0;
      if (Array.isArray(res) && res.length === 2) {
        const [count, ttlMs] = res as [number, number];
        if (count > limit) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000)),
          };
        }
        return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
      }
    } catch {
      redisFailureCount += 1;
      lastRedisStatus = "error";
      if (redisFailureCount >= REDIS_MAX_FAILURES) {
        // Stop hammering a dead Redis; the in-memory fallback takes over.
        redisDisabled = true;
        try {
          await redis.quit();
        } catch {
          /* already gone */
        }
        redisClient = null;
      }
    }
  } else if ((process.env.REDIS_URL || "").trim()) {
    lastRedisStatus = "connecting";
  } else {
    lastRedisStatus = "disabled";
  }

  // In-process fallback (per-instance).
  return slidingWindow(key, limit, windowMs);
}

/**
 * Best-effort client IP extraction from proxy headers.
 *
 * BUG-3 fix: the old implementation trusted the FIRST X-Forwarded-For entry —
 * a value the CLIENT fully controls. An attacker rotating a random XFF per
 * request got a fresh rate-limit bucket every time, bypassing every
 * clientIp-keyed limit (public menu, order-submit anti-spam, tracking).
 *
 * Trust model (documented, matches the bundled Caddyfile which REPLACES —
 * not appends — X-Forwarded-For with the real peer IP):
 *  - Default: use the LAST XFF entry (added by the closest trusted proxy —
 *    not client-controllable when a trusted proxy fronts the app).
 *  - TRUSTED_PROXY_HOPS=<n> (multi-proxy chains): use the entry n hops from
 *    the right (1 = last, 2 = second-to-last, …). Out-of-range → last.
 *  - No XFF → x-real-ip (also set by the reverse proxy, never by browsers).
 *  - Neither header → "unknown" (all such callers share one bucket — fails
 *    CLOSED for the limiter instead of trusting a spoofable value).
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const entries = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (entries.length > 0) {
      const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1);
      const idx = Math.max(0, entries.length - hops);
      return entries[idx];
    }
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test-only reset of the in-process buckets (keeps Redis untouched). */
export function __resetInMemoryBuckets(): void {
  buckets.clear();
  lastTouch.clear();
  redisClient = null;
  redisDisabled = false;
  redisFailureCount = 0;
  lastRedisStatus = "disabled";
}
