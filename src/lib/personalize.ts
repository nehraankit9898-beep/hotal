/**
 * Message personalization — Phase 2
 * Resolves {{variables}} in campaign templates with customer + hotel facts.
 * Unknown variables are removed (never shown raw to the customer).
 */

export interface PersonalizationContext {
  name: string;
  hotelName: string;
  lastVisit?: string | null; // formatted date of last checkout/checkin
  bookingCount?: number;
  offer?: string | null;
  bookingLink?: string | null;
}

export const TEMPLATE_VARIABLES = [
  { key: "{{name}}", description: "Customer's first name" },
  { key: "{{hotel_name}}", description: "Your hotel's name" },
  { key: "{{last_visit}}", description: "Last stay date" },
  { key: "{{booking_count}}", description: "Total stays at your hotel" },
  { key: "{{offer}}", description: "The offer attached to this campaign" },
  { key: "{{booking_link}}", description: "Direct booking link" },
] as const;

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function personalize(template: string, ctx: PersonalizationContext): string {
  const values: Record<string, string> = {
    "{{name}}": firstName(ctx.name),
    "{{hotel_name}}": ctx.hotelName,
    "{{last_visit}}": formatDate(ctx.lastVisit ?? null),
    "{{booking_count}}": ctx.bookingCount !== undefined ? String(ctx.bookingCount) : "",
    "{{offer}}": ctx.offer ?? "",
    "{{booking_link}}": ctx.bookingLink ?? process.env.BOOKING_LINK ?? "",
  };
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(key).join(value);
  }
  // Remove any leftover unknown {{...}} tokens so customers never see raw code
  out = out.replace(/\{\{[^}]*\}\}/g, "").replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

/** Sample context for test messages (admin preview). */
export function sampleContext(hotelName: string, offer?: string | null): PersonalizationContext {
  return {
    name: "Ankit Sharma",
    hotelName,
    lastVisit: new Date().toISOString(),
    bookingCount: 3,
    offer: offer ?? "20% OFF",
    bookingLink: process.env.BOOKING_LINK ?? "https://stayloop.example/book",
  };
}
