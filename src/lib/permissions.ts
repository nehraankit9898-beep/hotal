import { jsonError } from "@/lib/api-helpers";
import type { AuthedUser } from "@/lib/api-helpers";

/**
 * Centralized RBAC — Phase 5.
 *
 * A single permission matrix drives server-side authorization for every API
 * route. Frontend button-hiding is UX only; enforcement happens HERE.
 * SUPER_ADMIN intentionally bypasses hotel-scoped permissions (platform
 * operator), but hotel-scoped routes must never accept SUPER_ADMIN as a
 * tenant actor for writes — super admin manages tenants via /api/super-admin.
 */

export const PERMISSIONS = [
  "CUSTOMER_READ",
  "CUSTOMER_CREATE",
  "CUSTOMER_UPDATE",
  "CUSTOMER_DELETE",

  "VISIT_READ",
  "VISIT_CREATE",
  "VISIT_UPDATE",
  "VISIT_DELETE",

  "CAMPAIGN_READ",
  "CAMPAIGN_CREATE",
  "CAMPAIGN_UPDATE",
  "CAMPAIGN_SEND",
  "CAMPAIGN_DELETE",

  "SEGMENT_READ",
  "SEGMENT_CREATE",
  "SEGMENT_UPDATE",
  "SEGMENT_DELETE",

  "COUPON_READ",
  "COUPON_CREATE",
  "COUPON_UPDATE",
  "COUPON_REDEEM",
  "COUPON_DELETE",

  "AUTOMATION_READ",
  "AUTOMATION_CREATE",
  "AUTOMATION_UPDATE",
  "AUTOMATION_DELETE",

  "LEAD_READ",
  "LEAD_CREATE",
  "LEAD_UPDATE",
  "LEAD_DELETE",

  "RESTAURANT_READ",
  "RESTAURANT_WRITE",

  // Phase 6.3 — restaurant growth
  "LOYALTY_READ",
  "LOYALTY_MANAGE",
  "QR_READ",
  "QR_MANAGE",
  "FEEDBACK_READ",
  "TEMPLATE_READ",
  "TEMPLATE_MANAGE",
  "SETTINGS_MANAGE",

  "INTEGRATION_READ",
  "INTEGRATION_MANAGE",

  "STAFF_READ",
  "STAFF_MANAGE",

  "ANALYTICS_READ",
  "AUDIT_LOG_READ",
  "PROFILE_MANAGE",

  "SUPER_ADMIN_ACCESS",

  // Phase 12 — menu & tables (config vs availability split enforced server-side:
  // kitchen can flip availability but never touch price/configuration).
  "MENU_READ",
  "MENU_MANAGE",
  "MENU_AVAILABILITY",
  "TABLE_READ",
  "TABLE_MANAGE",

  // Phase 13 — ordering, floor, KDS. Preparation (PREPARING/READY) needs
  // ORDER_UPDATE; serving (SERVED) needs ORDER_SERVE; cancelling needs
  // ORDER_CANCEL (D03: the kitchen can no longer perform waiter/floor
  // operations — the preparation-vs-service split is server-enforced).
  "ORDER_READ",
  "ORDER_CREATE",
  "ORDER_UPDATE",
  "ORDER_SERVE",
  "ORDER_CANCEL",
  "KDS_ACCESS",
  "SESSION_MANAGE",

  // Phase 14 — POS, GST billing & payments. BILL_REFUND/BILL_VOID are
  // owner/manager-only (server-enforced); TAX_MANAGE is owner-only.
  "BILL_READ",
  "BILL_CREATE",
  "BILL_PAY",
  "BILL_REFUND",
  "BILL_VOID",
  "TAX_MANAGE",
  "CASH_SESSION_MANAGE",

  // Phase 15 — retention & marketing
  "PROMOTION_MANAGE",
  "REFERRAL_MANAGE",
  "PAYMENT_LINK_MANAGE",
  "REPORT_MANAGE",

  // Phase 16 — operations
  "RESERVATION_READ",
  "RESERVATION_MANAGE",
  "INVENTORY_READ",
  "INVENTORY_MANAGE",
  "ATTENDANCE_READ",
  "ATTENDANCE_MANAGE",
  "BRANCH_MANAGE",

  // Phase 17 — enterprise & platform completion. These permissions are also
  // the allowlist for owner-defined custom roles; an owner cannot grant a
  // permission they do not themselves hold.
  "FRANCHISE_MANAGE",
  "WHITE_LABEL_MANAGE",
  "CUSTOM_ROLE_MANAGE",
  "WEBHOOK_MANAGE",
  "AB_EXPERIMENT_MANAGE",
  "PRIVACY_REQUEST_MANAGE",
  "BENCHMARK_READ",
  "ENTERPRISE_API_MANAGE",

  // Phase 18 — advanced AI & innovation. AI_MANAGE covers approving/dismissing
  // recommendations, issuing/revoking wallet passes, running forecasts and
  // generating candidates — never the AI feature flags themselves (those are
  // owner/admin via SETTINGS_MANAGE-style checks on the settings route).
  "AI_READ",
  "AI_MANAGE",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_HOTEL: Permission[] = [
  "CUSTOMER_READ",
  "CUSTOMER_CREATE",
  "CUSTOMER_UPDATE",
  "CUSTOMER_DELETE",
  "VISIT_READ",
  "VISIT_CREATE",
  "VISIT_UPDATE",
  "VISIT_DELETE",
  "CAMPAIGN_READ",
  "CAMPAIGN_CREATE",
  "CAMPAIGN_UPDATE",
  "CAMPAIGN_SEND",
  "CAMPAIGN_DELETE",
  "SEGMENT_READ",
  "SEGMENT_CREATE",
  "SEGMENT_UPDATE",
  "SEGMENT_DELETE",
  "COUPON_READ",
  "COUPON_CREATE",
  "COUPON_UPDATE",
  "COUPON_REDEEM",
  "COUPON_DELETE",
  "AUTOMATION_READ",
  "AUTOMATION_CREATE",
  "AUTOMATION_UPDATE",
  "AUTOMATION_DELETE",
  "LEAD_READ",
  "LEAD_CREATE",
  "LEAD_UPDATE",
  "LEAD_DELETE",
  "RESTAURANT_READ",
  "RESTAURANT_WRITE",
  "LOYALTY_READ",
  "LOYALTY_MANAGE",
  "QR_READ",
  "QR_MANAGE",
  "FEEDBACK_READ",
  "TEMPLATE_READ",
  "TEMPLATE_MANAGE",
  "SETTINGS_MANAGE",
  "INTEGRATION_READ",
  "INTEGRATION_MANAGE",
  "STAFF_READ",
  "STAFF_MANAGE",
  "ANALYTICS_READ",
  "AUDIT_LOG_READ",
  "PROFILE_MANAGE",
  // Phase 12/13 — full restaurant operations
  "MENU_READ",
  "MENU_MANAGE",
  "MENU_AVAILABILITY",
  "TABLE_READ",
  "TABLE_MANAGE",
  "ORDER_READ",
  "ORDER_CREATE",
  "ORDER_UPDATE",
  "ORDER_SERVE",
  "ORDER_CANCEL",
  "KDS_ACCESS",
  "SESSION_MANAGE",
  // Phase 14/15/16 — owner/admin full operations
  "BILL_READ",
  "BILL_CREATE",
  "BILL_PAY",
  "BILL_REFUND",
  "BILL_VOID",
  "TAX_MANAGE",
  "CASH_SESSION_MANAGE",
  "PROMOTION_MANAGE",
  "REFERRAL_MANAGE",
  "PAYMENT_LINK_MANAGE",
  "REPORT_MANAGE",
  "RESERVATION_READ",
  "RESERVATION_MANAGE",
  "INVENTORY_READ",
  "INVENTORY_MANAGE",
  "ATTENDANCE_READ",
  "ATTENDANCE_MANAGE",
  "BRANCH_MANAGE",
  // Phase 17 — enterprise owner/admin full access
  "FRANCHISE_MANAGE",
  "WHITE_LABEL_MANAGE",
  "CUSTOM_ROLE_MANAGE",
  "WEBHOOK_MANAGE",
  "AB_EXPERIMENT_MANAGE",
  "PRIVACY_REQUEST_MANAGE",
  "BENCHMARK_READ",
  "ENTERPRISE_API_MANAGE",
  // Phase 18 — owner/admin full AI access
  "AI_READ",
  "AI_MANAGE",
];

const READ_ONLY_CORE: Permission[] = [
  "CUSTOMER_READ",
  "VISIT_READ",
  "CAMPAIGN_READ",
  "SEGMENT_READ",
  "COUPON_READ",
  "AUTOMATION_READ",
  "LEAD_READ",
  "RESTAURANT_READ",
  "LOYALTY_READ",
  "QR_READ",
  "FEEDBACK_READ",
  "TEMPLATE_READ",
  "INTEGRATION_READ",
  "STAFF_READ",
  "ANALYTICS_READ",
  "PROFILE_MANAGE",
  // Phase 12/13 — read-only catalog/order visibility
  "MENU_READ",
  "TABLE_READ",
  "ORDER_READ",
  // Phase 14/15/16 — read-only visibility
  "BILL_READ",
  "RESERVATION_READ",
  "INVENTORY_READ",
  "ATTENDANCE_READ",
  // AUDIT FIX (XCUT-PERM-1): PROMOTION_MANAGE / REFERRAL_MANAGE /
  // REPORT_MANAGE leaked into the read-only core, so nominally read-only
  // roles (HOTEL_STAFF, FRONT_DESK) could create/edit promotions, referral
  // programs and report schedules. Only *_MANAGE permissions gate those
  // features (no *_READ exists), so read-only roles lose that visibility —
  // the safe direction.
  // Phase 17 — read-only benchmark visibility for context.
  "BENCHMARK_READ",
];

const OPERATIONAL: Permission[] = [
  ...READ_ONLY_CORE,
  "CUSTOMER_CREATE",
  "CUSTOMER_UPDATE",
  "VISIT_CREATE",
  "VISIT_UPDATE",
  "COUPON_REDEEM",
  "RESTAURANT_WRITE",
  "LEAD_READ",
];

const MARKETING: Permission[] = [
  ...READ_ONLY_CORE,
  "CAMPAIGN_CREATE",
  "CAMPAIGN_UPDATE",
  "CAMPAIGN_SEND",
  "CAMPAIGN_DELETE",
  "SEGMENT_CREATE",
  "SEGMENT_UPDATE",
  "SEGMENT_DELETE",
  "COUPON_CREATE",
  "COUPON_UPDATE",
  "COUPON_DELETE",
  "AUTOMATION_CREATE",
  "AUTOMATION_UPDATE",
  "AUTOMATION_DELETE",
  "LEAD_CREATE",
  "LEAD_UPDATE",
  "LEAD_DELETE",
  "RESTAURANT_WRITE",
  // Phase 18 — marketing can view AI output and approve recommendation sends
  // (the prompt assigns approval to owner/marketing; feature FLAGS stay owner-only).
  "AI_READ",
  "AI_MANAGE",
  // Phase 15 — marketing owns promotions/referrals/report schedule.
  // PAYMENT_LINK_MANAGE stays with floor/cashier-side roles.
  "PROMOTION_MANAGE",
  "REFERRAL_MANAGE",
  "REPORT_MANAGE",
];

const RESTAURANT_OPS: Permission[] = [
  ...READ_ONLY_CORE,
  "RESTAURANT_WRITE",
  "COUPON_REDEEM",
  "LOYALTY_MANAGE",
  "QR_MANAGE",
  "CUSTOMER_CREATE",
  "CUSTOMER_UPDATE",
  "VISIT_CREATE",
  "VISIT_UPDATE",
  // Phase 12/13 — full restaurant floor operations
  "MENU_MANAGE",
  "MENU_AVAILABILITY",
  "TABLE_MANAGE",
  "ORDER_CREATE",
  "ORDER_UPDATE",
  "ORDER_SERVE",
  "ORDER_CANCEL",
  "KDS_ACCESS",
  "SESSION_MANAGE",
  // Phase 14/15/16 — restaurant manager: bills/refunds/cash + operations.
  // NO BILL_VOID (owner-only), NO TAX_MANAGE (owner-only).
  "BILL_READ",
  "BILL_CREATE",
  "BILL_PAY",
  "BILL_REFUND",
  "CASH_SESSION_MANAGE",
  "PAYMENT_LINK_MANAGE",
  "RESERVATION_MANAGE",
  "INVENTORY_MANAGE",
  "ATTENDANCE_MANAGE",
  // Phase 18 — restaurant manager views AI output (cannot approve sends;
  // approval is owner/marketing per the role matrix).
  "AI_READ",
];

// Phase 13 — KITCHEN_STAFF: the KDS queue and item availability ONLY. No CRM,
// no marketing, no finance, no exports — enforced server-side, not just UI.
// Phase 16: + read-only stock visibility. Still NO billing permissions.
const KITCHEN: Permission[] = [
  "PROFILE_MANAGE",
  "MENU_READ",
  "MENU_AVAILABILITY",
  "ORDER_READ",
  "ORDER_UPDATE", // item/order preparation transitions on the KDS
  "KDS_ACCESS",
  "INVENTORY_READ", // stock awareness only (no edits — see INVENTORY_MANAGE)
];

// Phase 13 — WAITER: floor workflow. Take orders, serve, manage table
// sessions. No catalog config, no marketing, no finance. Phase 14: can see
// bills for context; Phase 16: can view/manage reservations on the floor.
const WAITER: Permission[] = [
  "PROFILE_MANAGE",
  "MENU_READ",
  "TABLE_READ",
  "ORDER_READ",
  "ORDER_CREATE",
  "ORDER_UPDATE", // preparation assist
  "ORDER_SERVE", // mark orders/items served (floor operation)
  "ORDER_CANCEL", // request/record cancellations on the floor
  "SESSION_MANAGE",
  "CUSTOMER_READ", // recognize the diner at the table (name/phone only)
  "BILL_READ", // view the open bill for their tables (cannot pay/refund)
  "RESERVATION_READ",
  "RESERVATION_MANAGE",
];

// Phase 13 — CASHIER: billing-relevant order visibility + coupon redemption
// for billing. Phase 14 expands: create/pay bills + cash drawer. The cashier
// can NEVER refund, void, configure taxes or export financial data.
const CASHIER: Permission[] = [
  "PROFILE_MANAGE",
  "MENU_READ",
  "TABLE_READ",
  "ORDER_READ",
  "COUPON_READ",
  "COUPON_REDEEM", // apply billing discounts
  "BILL_READ",
  "BILL_CREATE",
  "BILL_PAY",
  "CASH_SESSION_MANAGE",
  "RESERVATION_READ",
];

// Phase 16 — KITCHEN_STAFF gains read-only stock visibility (availability
// awareness) but NEVER inventory edits or any billing permission.
const KITCHEN_INVENTORY_READ: Permission[] = ["INVENTORY_READ"];

export const ROLE_PERMISSIONS: Record<AuthedUser["role"], Permission[]> = {
  SUPER_ADMIN: [
    "SUPER_ADMIN_ACCESS",
    "ANALYTICS_READ",
    "AUDIT_LOG_READ",
    "STAFF_READ",
    "PROFILE_MANAGE",
  ],
  HOTEL_OWNER: ALL_HOTEL,
  HOTEL_ADMIN: ALL_HOTEL,
  HOTEL_MANAGER: OPERATIONAL.filter(
    (p) => p !== "INTEGRATION_MANAGE" && p !== "STAFF_MANAGE",
  ).concat([
    "AUDIT_LOG_READ",
    "MENU_MANAGE",
    "MENU_AVAILABILITY",
    "TABLE_MANAGE",
    "ORDER_CREATE",
    "ORDER_UPDATE",
    "ORDER_SERVE",
    "ORDER_CANCEL",
    "KDS_ACCESS",
    "SESSION_MANAGE",
    // Phase 14/15/16 — hotel manager: restaurant ops incl. billing/refunds,
    // NO BILL_VOID / TAX_MANAGE (owner-only), NO BRANCH_MANAGE.
    "BILL_READ",
    "BILL_CREATE",
    "BILL_PAY",
    "BILL_REFUND",
    "CASH_SESSION_MANAGE",
    "PAYMENT_LINK_MANAGE",
    "PROMOTION_MANAGE",
    "REFERRAL_MANAGE",
    "REPORT_MANAGE",
    "RESERVATION_READ",
    "RESERVATION_MANAGE",
    "INVENTORY_READ",
    "INVENTORY_MANAGE",
    "ATTENDANCE_READ",
    "ATTENDANCE_MANAGE",
  ]),
  MARKETING_MANAGER: MARKETING.filter((p) => p !== "STAFF_MANAGE" && p !== "INTEGRATION_MANAGE"),
  RESTAURANT_MANAGER: RESTAURANT_OPS,
  FRONT_DESK: OPERATIONAL.filter(
    (p) => p !== "INTEGRATION_MANAGE" && p !== "STAFF_MANAGE" && p !== "AUDIT_LOG_READ",
  ),
  HOTEL_STAFF: READ_ONLY_CORE.filter((p) => p !== "INTEGRATION_READ" && p !== "STAFF_READ"),
  // Phase 13 — restaurant staff roles (see role matrix in PHASE_13_HANDOFF.md)
  CASHIER: CASHIER,
  KITCHEN_STAFF: KITCHEN,
  WAITER: WAITER,
};

/**
 * Server-side authorization. requireAuth supplies a fresh DB-resolved permission
 * set on each request. The role-only form remains for legacy matrix checks;
 * it cannot grant custom permissions and must not be used with client data.
 */
export function hasPermission(
  user: Pick<AuthedUser, "role"> & { permissions?: readonly Permission[] },
  permission: Permission,
): boolean {
  if (user.permissions !== undefined) {
    return Array.isArray(user.permissions) && user.permissions.includes(permission);
  }
  return ROLE_PERMISSIONS[user.role]?.includes(permission) ?? false;
}

/**
 * Require a permission for the current request.
 * Returns a 403 NextResponse when denied, so callers can do:
 *   const denied = requirePermission(auth.user, "CAMPAIGN_SEND"); if (denied) return denied;
 */
export function requirePermission(
  user: Pick<AuthedUser, "role"> & { permissions?: readonly Permission[] },
  permission: Permission,
): ReturnType<typeof jsonError> | null {
  if (!hasPermission(user, permission)) {
    return jsonError("You do not have permission to perform this action.", 403, "FORBIDDEN");
  }
  return null;
}
