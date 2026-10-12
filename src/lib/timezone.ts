/**
 * Hotel-local calendar helpers.
 *
 * BUG FIX: the follow-up engine, automations and the daily send cap compared
 * dates with the SERVER's local calendar (getFullYear/getDate). On a UTC server
 * an Indian hotel's guest who checked out at 01:30 IST was treated as checking
 * out on the previous day, so "1 day after checkout" messages fired on the
 * wrong day. Calendar-day logic must use the hotel's own timezone.
 */

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The hotel's IANA timezone, falling back to the platform default. */
export async function hotelTimezone(hotelId: string): Promise<string> {
  // Lazy import keeps the calendar helpers above free of DB side effects.
  const { db } = await import("@/lib/db");
  const hotel = await db.hotel.findUnique({
    where: { id: hotelId },
    select: { timezone: true },
  });
  return isValidTimeZone(hotel?.timezone) ? hotel.timezone : DEFAULT_TIMEZONE;
}

/** "YYYY-MM-DD" for an instant, as seen on the wall clock in `tz`. */
export function zonedDayKey(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function sameZonedDay(a: Date, b: Date, tz: string): boolean {
  return zonedDayKey(a, tz) === zonedDayKey(b, tz);
}

/** Offset (ms) of `tz` from UTC at the given instant: wall clock − UTC. */
function zoneOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - instantSeconds;
}

/** The instant local midnight begins on calendar day (y, m, d) in `tz`. */
function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const midnightUtc = Date.UTC(y, m - 1, d);
  // Two passes handle a DST transition inside the day.
  const first = midnightUtc - zoneOffsetMs(new Date(midnightUtc), tz);
  const second = midnightUtc - zoneOffsetMs(new Date(first), tz);
  return new Date(second);
}

/** The instant at which the hotel's local calendar day containing `date` begins. */
export function startOfZonedDay(date: Date, tz: string): Date {
  const [y, m, d] = zonedDayKey(date, tz).split("-").map(Number);
  return zonedMidnight(y, m, d, tz);
}

/**
 * UTC bounds [start, end) of the local business day `dateStr` ("YYYY-MM-DD")
 * in `tz` — 24h normally, 23h/25h across DST changes.
 *
 * BUG FIX: the sales report and the owner daily report each carried a copy of
 * a helper that derived the "offset" from the calendar DATE alone, so every
 * timezone got the same window: 12:00 UTC on the day to 23:59 UTC the next
 * day (36h). Morning sales went missing and consecutive days double-counted.
 */
export function zonedDayBounds(dateStr: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Date.UTC normalises day overflow (Jan 31 + 1 → Feb 1).
  return { start: zonedMidnight(y, m, d, tz), end: zonedMidnight(y, m, d + 1, tz) };
}
