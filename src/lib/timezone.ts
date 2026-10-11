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

/** The instant at which the hotel's local calendar day containing `date` begins. */
export function startOfZonedDay(date: Date, tz: string): Date {
  const [y, m, d] = zonedDayKey(date, tz).split("-").map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  // Two passes handle a DST transition inside the day.
  const first = midnightUtc - zoneOffsetMs(new Date(midnightUtc), tz);
  const second = midnightUtc - zoneOffsetMs(new Date(first), tz);
  return new Date(second);
}
