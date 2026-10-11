/**
 * Phone number validation + normalization.
 * - Validates format (digits, optional leading +)
 * - Normalizes to E.164-like: +<countrycode><number>
 * - Handles Indian formats (10-digit mobile, 0-prefix, 91-prefix)
 * - Never used as primary key (uuid ids used everywhere)
 */

export interface PhoneResult {
  ok: boolean;
  normalized?: string;
  error?: string;
}

export function normalizePhone(raw: string): PhoneResult {
  if (typeof raw !== "string") return { ok: false, error: "Phone number is required." };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Phone number is required." };

  // Reject letters and suspicious characters (allow +, digits, spaces, dashes, parentheses, dots)
  if (/[a-zA-Z]/.test(trimmed)) {
    return { ok: false, error: "Phone number cannot contain letters." };
  }
  let cleaned = trimmed.replace(/[\s\-().]/g, "");

  // Handle 00 international prefix
  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  }

  const hasPlus = cleaned.startsWith("+");
  let digits = cleaned.replace(/\+/g, "");

  if (!/^\d+$/.test(digits)) {
    return { ok: false, error: "Phone number contains invalid characters." };
  }

  // Indian local formats → +91
  if (!hasPlus) {
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
      digits = "91" + digits;
    } else if (digits.length === 11 && digits.startsWith("0")) {
      digits = "91" + digits.slice(1);
    } else if (digits.length === 12 && digits.startsWith("91")) {
      // already has country code
    }
  }

  if (hasPlus || digits.length > 10) {
    if (digits.length < 8) return { ok: false, error: "Phone number is too short (min 8 digits)." };
    if (digits.length > 15)
      return { ok: false, error: "Phone number is too long (max 15 digits)." };
    return { ok: true, normalized: "+" + digits };
  }

  // Bare number without country code
  if (digits.length < 8) return { ok: false, error: "Phone number is too short (min 8 digits)." };
  if (digits.length > 15) return { ok: false, error: "Phone number is too long (max 15 digits)." };
  return { ok: true, normalized: "+" + digits };
}

/** Quick boolean check for API validation. */
export function isValidPhone(raw: string): boolean {
  return normalizePhone(raw).ok;
}

/** Privacy masking (canonical, shared by client AND server):
 *  9876543210 / +919876543210 → ******3210 (spec Phase 8.1 §1).
 *  Keeps the last 4 digits, masks everything before them.
 *  IDEMPOTENT: an already-masked value (contains "*") passes through
 *  unchanged, so defense-in-depth client masking never corrupts
 *  server-masked API responses. Empty values render as "—". */
export function maskPhoneDisplay(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return "—";
  if (raw.includes("*")) return raw; // already masked — never re-mask
  // Strip formatting characters and a leading +91 (Indian country code)
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91") && digits.length === 13) digits = digits.slice(3);
  else if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return "—"; // malformed → never echo raw input
  if (digits.length <= 4) return "*".repeat(digits.length);
  return "*".repeat(digits.length - 4) + digits.slice(-4);
}

/** Display formatting: +91 98765 43210 */
export function formatPhoneDisplay(normalized: string): string {
  if (!normalized) return "";
  if (normalized.startsWith("+91") && normalized.length === 13) {
    const rest = normalized.slice(3);
    return `+91 ${rest.slice(0, 5)} ${rest.slice(5)}`;
  }
  return normalized;
}

/** Privacy masking: +91 98••• ••210 */
export function maskPhone(normalized: string): string {
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  const head = normalized.slice(0, 6);
  const tail = normalized.slice(-3);
  const maskedLen = Math.max(normalized.length - 9, 2);
  return `${head}${"•".repeat(maskedLen)}${tail}`;
}
