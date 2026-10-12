/**
 * Pure, dependency-free staff-account guards (unit-testable without a database).
 */

export type StaffRole =
  | "HOTEL_OWNER"
  | "HOTEL_ADMIN"
  | "HOTEL_MANAGER"
  | "MARKETING_MANAGER"
  | "RESTAURANT_MANAGER"
  | "FRONT_DESK"
  | "HOTEL_STAFF"
  | "CASHIER"
  | "KITCHEN_STAFF"
  | "WAITER"
  | "SUPER_ADMIN";

/**
 * AUDIT FIX (SEC-001): hierarchy guard for staff-account management.
 *
 * STAFF_MANAGE is held by HOTEL_OWNER and HOTEL_ADMIN. Without a rank check an
 * admin could suspend, demote, revoke the sessions of, or re-invite the HOTEL_OWNER
 * — i.e. lock the account holder out of their own tenant. Only the owner may act
 * on an owner account. Peer admins may still manage each other (existing behavior).
 */
export function canActOnStaffTarget(actorRole: StaffRole, targetRole: StaffRole): boolean {
  if (targetRole === "HOTEL_OWNER") return actorRole === "HOTEL_OWNER";
  return true;
}
