> **Historical snapshot (2026-10-11).** For this checkout, see [FINAL_VERIFICATION_REPORT.md](FINAL_VERIFICATION_REPORT.md), [REPAIR_CHANGELOG.md](REPAIR_CHANGELOG.md) and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md). Statements below describe the earlier audit, not the post-repair result.

# Role → Permission Matrix (generated)

Extracted from `src/lib/permissions.ts` (`ROLE_PERMISSIONS`). Regenerate with `python3 audit/tools/generate_inventory.py`.

- Roles defined in `ROLE_PERMISSIONS`: **11**
- Distinct permission identifiers: **88**
- Default-deny: `hasPermission` returns `false` for an unknown role or a permission not in the role's list (verified in source).
- **Custom roles are NOT enforced at runtime.** `resolveUserPermissions()` (src/lib/custom-roles.ts) merges custom-role grants, but it is only called to check what a caller may grant when creating roles. `requirePermission()` reads the static `ROLE_PERMISSIONS` table only, so a custom-role grant never unlocks a route. This is finding FUNC-001 in audit/FUNCTIONAL_BUGS.md. It fails closed (no escalation), but the feature does not work as documented.

## Per-role counts

| Role | Permissions |
|---|---|
| `SUPER_ADMIN` | 5 |
| `HOTEL_OWNER` | 87 |
| `HOTEL_ADMIN` | 87 |
| `HOTEL_MANAGER` | 56 |
| `MARKETING_MANAGER` | 46 |
| `RESTAURANT_MANAGER` | 51 |
| `FRONT_DESK` | 31 |
| `HOTEL_STAFF` | 22 |
| `CASHIER` | 11 |
| `KITCHEN_STAFF` | 7 |
| `WAITER` | 13 |

## Full matrix (✓ = granted)

| Permission | `SUPER_ADMIN` | `HOTEL_OWNER` | `HOTEL_ADMIN` | `HOTEL_MANAGER` | `MARKETING_MANAGER` | `RESTAURANT_MANAGER` | `FRONT_DESK` | `HOTEL_STAFF` | `CASHIER` | `KITCHEN_STAFF` | `WAITER` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `AB_EXPERIMENT_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `AI_MANAGE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `AI_READ` |  | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |
| `ANALYTICS_READ` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `ATTENDANCE_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `ATTENDANCE_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `AUDIT_LOG_READ` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| `AUTOMATION_CREATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `AUTOMATION_DELETE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `AUTOMATION_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `AUTOMATION_UPDATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `BENCHMARK_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `BILL_CREATE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  | ✓ |  |  |
| `BILL_PAY` |  | ✓ | ✓ | ✓ |  | ✓ |  |  | ✓ |  |  |
| `BILL_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `BILL_REFUND` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `BILL_VOID` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `BRANCH_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `CAMPAIGN_CREATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `CAMPAIGN_DELETE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `CAMPAIGN_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `CAMPAIGN_SEND` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `CAMPAIGN_UPDATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `CASH_SESSION_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  | ✓ |  |  |
| `COUPON_CREATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `COUPON_DELETE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `COUPON_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `COUPON_REDEEM` |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |  | ✓ |  |  |
| `COUPON_UPDATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `CUSTOMER_CREATE` |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |
| `CUSTOMER_DELETE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `CUSTOMER_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `CUSTOMER_UPDATE` |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |
| `CUSTOM_ROLE_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `ENTERPRISE_API_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `FEEDBACK_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `FRANCHISE_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `INTEGRATION_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `INTEGRATION_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `INVENTORY_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `INVENTORY_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |
| `KDS_ACCESS` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |
| `LEAD_CREATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `LEAD_DELETE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `LEAD_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `LEAD_UPDATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `LOYALTY_MANAGE` |  | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |
| `LOYALTY_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `MENU_AVAILABILITY` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |
| `MENU_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `MENU_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ORDER_CANCEL` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ |
| `ORDER_CREATE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ |
| `ORDER_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ORDER_SERVE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ |
| `ORDER_UPDATE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  | ✓ | ✓ |
| `PAYMENT_LINK_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `PRIVACY_REQUEST_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `PROFILE_MANAGE` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `PROMOTION_MANAGE` |  | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `QR_MANAGE` |  | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |
| `QR_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `REFERRAL_MANAGE` |  | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `REPORT_MANAGE` |  | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `RESERVATION_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ |
| `RESERVATION_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `RESTAURANT_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `RESTAURANT_WRITE` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `SEGMENT_CREATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `SEGMENT_DELETE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `SEGMENT_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `SEGMENT_UPDATE` |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `SESSION_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  | ✓ |
| `SETTINGS_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `STAFF_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `STAFF_READ` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `SUPER_ADMIN_ACCESS` | ✓ |  |  |  |  |  |  |  |  |  |  |
| `TABLE_MANAGE` |  | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `TABLE_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `TAX_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `TEMPLATE_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `TEMPLATE_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `VISIT_CREATE` |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |
| `VISIT_DELETE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `VISIT_READ` |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `VISIT_UPDATE` |  | ✓ | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |
| `WEBHOOK_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `WHITE_LABEL_MANAGE` |  | ✓ | ✓ |  |  |  |  |  |  |  |  |
