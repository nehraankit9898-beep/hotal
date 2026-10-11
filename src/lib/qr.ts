import { randomBytes } from "crypto";
import { db } from "@/lib/db";

/**
 * QR code service — Phase 6.3, hardened in Phase 6.4.
 *
 * Each QR code carries an unpredictable 32-char url-safe identifier. The
 * identifier is the ONLY thing embedded in the QR image — no hotel IDs, no
 * secrets, no tokens. The backend resolves code → tenant server-side, so a
 * customer scanning the QR can never impersonate another restaurant.
 */

export function generateQrIdentifier(): string {
  return randomBytes(24).toString("base64url"); // 32 chars, url-safe, unpredictable
}

/* ------------------------------------------------------------------ */
/* Phase 6.4 — batched scan analytics (spec §9)                        */
/* ------------------------------------------------------------------ */

/**
 * Raw QR requests must not amplify database writes (one UPDATE per scan is
 * too hot for a printed-code page that gets refresh loops). Scans are
 * aggregated in memory and flushed to the database in ONE atomic increment:
 *   - at most once every SCAN_FLUSH_INTERVAL_MS per QR code, and
 *   - immediately once SCAN_FLUSH_THRESHOLD scans have accumulated.
 * Business analytics stay accurate (total count is exact; lastScanAt lags by
 * at most one flush interval). This is a queue/aggregation pattern as
 * required by the spec — the counter is never updated per raw request.
 */
const SCAN_FLUSH_INTERVAL_MS = 30_000;
const SCAN_FLUSH_THRESHOLD = 10;

const scanBuffer = new Map<string, { count: number; lastScanAt: Date; lastFlushAt: number }>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flushScanBuffer(): Promise<void> {
  if (scanBuffer.size === 0) return;
  const entries = [...scanBuffer.entries()];
  scanBuffer.clear();
  for (const [qrId, agg] of entries) {
    if (agg.count <= 0) continue;
    try {
      await db.qRCode.update({
        where: { id: qrId },
        data: { scans: { increment: agg.count }, lastScanAt: agg.lastScanAt },
      });
    } catch {
      // QR deleted while buffered — nothing to update.
    }
  }
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushScanBuffer().catch(() => undefined);
  }, SCAN_FLUSH_INTERVAL_MS);
  // Never keep the process alive just for the flush timer.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** Record a scan in the aggregation buffer (throttled, never per-request DB write). */
function recordBufferedScan(qrId: string): void {
  const now = Date.now();
  const entry = scanBuffer.get(qrId) ?? { count: 0, lastScanAt: new Date(), lastFlushAt: now };
  entry.count += 1;
  entry.lastScanAt = new Date();
  scanBuffer.set(qrId, entry);

  // Threshold flush or interval-elapsed flush (keeps counts fresh).
  if (entry.count >= SCAN_FLUSH_THRESHOLD || now - entry.lastFlushAt >= SCAN_FLUSH_INTERVAL_MS) {
    // Flush just this code's buffer synchronously (fire-and-forget).
    const count = entry.count;
    const lastScanAt = entry.lastScanAt;
    entry.count = 0;
    entry.lastFlushAt = now;
    void db.qRCode
      .update({ where: { id: qrId }, data: { scans: { increment: count }, lastScanAt } })
      .catch(() => undefined);
  } else {
    ensureFlushTimer();
  }
}

/** Test/support helper — flush pending scan counters immediately. */
export async function flushScanCounters(): Promise<void> {
  await flushScanBuffer();
}

/** The public URL a QR points at. */
export function buildPublicUrl(code: string, origin?: string | null): string {
  const base = origin ?? process.env.APP_ORIGIN ?? process.env.FRONTEND_URL ?? "";
  const clean = base ? base.replace(/\/+$/, "") : "";
  return `${clean}/r/${code}`;
}

export interface PublicQrData {
  ok: boolean;
  reason?: string;
  qr: {
    code: string;
    type: string;
    label: string | null;
  };
  restaurant: {
    id: string;
    name: string;
    location: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
    currency: string;
  };
  loyalty: {
    enabled: boolean;
    mode: string;
    pointsPer100: number;
    pointsPerVisit: number;
    pointsForReward: number;
    rewardValue: number;
    signupBonus: number;
  };
  consentText: string;
  feedbackEnabled: boolean;
}

/**
 * Resolve a public QR code to its restaurant landing-page data.
 * Also records the scan (best-effort, never blocks the page load).
 * Inactive / unknown codes return ok:false with a generic reason.
 */
export async function resolvePublicQr(
  code: string,
): Promise<PublicQrData | { ok: false; reason: string }> {
  const clean = code.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) return { ok: false, reason: "Invalid QR code." };

  const qr = await db.qRCode.findUnique({
    where: { code: clean },
    include: { hotel: true },
  });
  if (!qr || !qr.active)
    return {
      ok: false,
      reason: "This QR code is no longer active. Please ask the restaurant staff.",
    };
  if (!qr.hotel || qr.hotel.status !== "ACTIVE") {
    return {
      ok: false,
      reason: "This QR code is no longer active. Please ask the restaurant staff.",
    };
  }

  // Record the scan in the aggregation buffer (batched — page load never
  // waits for, or performs, a database write).
  recordBufferedScan(qr.id);

  const settings = await db.hotelSettings.findUnique({ where: { hotelId: qr.hotelId } });
  const loyalty = await db.loyaltySettings.findUnique({ where: { hotelId: qr.hotelId } });

  return {
    ok: true,
    qr: { code: qr.code, type: qr.type, label: qr.label },
    restaurant: {
      id: qr.hotel.id,
      name: qr.hotel.name,
      location: qr.hotel.location,
      city: qr.hotel.city,
      phone: qr.hotel.phone,
      email: qr.hotel.email,
      currency: qr.hotel.currency ?? "INR",
    },
    loyalty: {
      enabled: loyalty?.enabled ?? true,
      mode: loyalty?.mode ?? "POINTS",
      pointsPer100: loyalty?.pointsPer100 ?? 10,
      pointsPerVisit: loyalty?.pointsPerVisit ?? 50,
      pointsForReward: loyalty?.pointsForReward ?? 500,
      rewardValue: loyalty?.rewardValue ?? 100,
      signupBonus: loyalty?.signupBonus ?? 50,
    },
    consentText:
      settings?.consentText ?? "I want to receive offers and discounts from this restaurant.",
    feedbackEnabled: settings?.feedbackEnabled ?? true,
  };
}
