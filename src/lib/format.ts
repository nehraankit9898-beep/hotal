/** Human-friendly formatting helpers. */

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-IN");
}

/** Indian-style currency formatting: ₹1,234.56 */
export function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

/** yyyy-MM-ddTHH:mm for datetime-local inputs */
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Masked phone display — canonical implementation lives in lib/phone.ts
 *  (single source of truth, shared client + server — Phase 8.1 §1).
 *  Re-exported here so existing client imports keep working. */
export { maskPhoneDisplay } from "@/lib/phone";

export function phoneDisplay(normalized: string): string {
  if (!normalized) return "—";
  if (normalized.startsWith("+91") && normalized.length === 13) {
    const rest = normalized.slice(3);
    return `+91 ${rest.slice(0, 5)} ${rest.slice(5)}`;
  }
  return normalized;
}

export const AUDIT_LABELS: Record<string, string> = {
  LOGIN: "Signed in",
  LOGIN_FAILED: "Failed sign-in attempt",
  LOGOUT: "Signed out",
  HOTEL_CREATED: "Hotel registered",
  CUSTOMER_CREATED: "Customer added",
  CUSTOMER_UPDATED: "Customer updated",
  CUSTOMER_DEACTIVATED: "Customer deactivated",
  CUSTOMER_REACTIVATED: "Customer reactivated",
  CONSENT_GRANTED: "Marketing consent given",
  CONSENT_REVOKED: "Consent revoked",
  OPT_OUT: "Marketing opt-out",
  VISIT_CREATED: "Visit recorded",
  VISIT_UPDATED: "Visit updated",
  VISIT_DELETED: "Visit deleted",
  CUSTOMERS_IMPORTED: "Customers imported (CSV)",
  VISITS_IMPORTED: "Visits imported (CSV)",
  PROFILE_UPDATED: "Profile updated",
  PASSWORD_CHANGED: "Password changed",
};
