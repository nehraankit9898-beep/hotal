/**
 * Phase 15 — owner report schedule sweep (worker module).
 *
 * Drains due ReportSchedule rows exactly-once per occurrence:
 *  - next-due is derived from (frequency, weekday, hour) in the TENANT
 *    timezone; `lastSentAt` acts as the occurrence fence.
 *  - enqueues one OWNER_REPORT background job per due schedule; the job
 *    handler is idempotent (it re-checks the schedule + recipients).
 */

import { db } from "@/lib/db";

const DAY_MS = 24 * 3600_000;

/** Local (tenant-tz) "now" parts via Intl. */
function localParts(tz: string, at: Date): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hour = Number(get("hour")) % 24;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get("weekday")] ?? 0;
  return { date: `${y}-${m}-${d}`, hour, weekday };
}

/** Offset of `tz` from UTC in minutes at `at` (positive east of UTC). */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * Enqueue OWNER_REPORT jobs for every active schedule whose local hour has
 * arrived since the last successful send. Multiple workers are safe: the
 * enqueue is guarded by a conditional updateMany on lastSentAt.
 *
 * AUDIT FIX (P11-RPT-1): the occurrence fence used to be the top of the UTC
 * hour while the TRIGGER is the tenant-local hour. For half-hour timezones
 * (default Asia/Kolkata, +05:30) the local hour straddles a UTC boundary, so
 * the same local hour claimed twice and owners received duplicate reports.
 * The fence is now the start of the CURRENT LOCAL HOUR expressed in UTC.
 */
export async function sweepOwnerReports(now = new Date()): Promise<number> {
  const schedules = await db.reportSchedule.findMany({ where: { active: true } });
  let enqueued = 0;
  for (const s of schedules) {
    const hotel = await db.hotel.findUnique({ where: { id: s.hotelId }, select: { timezone: true, status: true } });
    if (!hotel || hotel.status !== "ACTIVE") continue;
    const tz = hotel.timezone || "Asia/Kolkata";
    const local = localParts(tz, now);
    if (local.hour !== s.hour) continue; // fire once per local hour match
    if (s.frequency === "WEEKLY" && s.weekday !== local.weekday) continue;

    // Occurrence fence: only enqueue if we have not already sent in this
    // local hour window (lastSentAt < start of the current TENANT-LOCAL hour).
    const offsetMin = tzOffsetMinutes(tz, now);
    const [ly, lm, ld] = local.date.split("-").map(Number);
    const localHourStartUtc = new Date(Date.UTC(ly, lm - 1, ld, local.hour, 0, 0) - offsetMin * 60_000);
    if (s.lastSentAt && s.lastSentAt >= localHourStartUtc) continue;

    const claimed = await db.reportSchedule.updateMany({
      where: { id: s.id, lastSentAt: s.lastSentAt },
      data: { lastSentAt: now },
    });
    if (claimed.count === 0) continue; // another worker claimed this hour

    await db.backgroundJob.create({
      data: {
        hotelId: s.hotelId,
        type: "OWNER_REPORT",
        status: "QUEUED",
        payload: JSON.stringify({ hotelId: s.hotelId, localDate: local.date, timezone: tz }),
      },
    });
    enqueued += 1;
  }
  return enqueued;
}

export const OWNER_REPORT_SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 minutes
