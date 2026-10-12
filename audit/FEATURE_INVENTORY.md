# Feature Inventory — StayLoop (2026-10-11)

Derived from source (`src/app/api/**/route.ts`, `src/app/**/page.tsx`, `src/components/app/*-view.tsx`, `src/lib/*.ts`),
not only from the README. "Observed" means the source exists; it does NOT mean the feature was run.
Status values: **Source present** · **Partially reviewed** · **NOT AUDITED** · **Known defect** · **Blocked by config**.

| Module | Features (observed in source) | Key files | Roles (from permissions) | Tests in repo | Audit status |
|---|---|---|---|---|---|
| **Auth** | Login (+ lockout, IP throttle), logout (revokes all), register/onboard, activate invite, forgot/reset password, email verify + resend, MFA setup/enable/disable/backup codes/verify | `src/app/api/auth/*`, `src/app/api/mfa/*`, `src/lib/auth.ts`, `login-security.ts`, `mfa.ts`, `security-tokens.ts` | any | `auth`, `lockout`, `security`, `security-hardening` | Partially reviewed (static) · SEC-006 fixed |
| **Sessions / CSRF** | Cookie + bearer sessions, `tokenVersion` revocation, CSRF double-submit + Origin check, mustChangePassword gate, MFA-enrolment gate | `src/lib/api-helpers.ts`, `src/lib/csrf.ts`, `src/proxy.ts` | — | `security`, `security-hardening` | Partially reviewed · SEC-002, SEC-005 fixed |
| **Staff & roles** | Staff list/invite, role change (assignable list), suspend/reactivate, revoke sessions, re-invite | `src/app/api/staff/*`, `src/lib/permissions.ts` | HOTEL_OWNER, HOTEL_ADMIN (`STAFF_MANAGE`) | `phase13-orders` (partial) | Partially reviewed · SEC-001 fixed |
| **Custom roles** | Create role from permission allowlist, assign to users | `src/app/api/custom-roles/*`, `src/lib/custom-roles.ts` | owner/admin | `phase17-enterprise` | **Known defect FUNC-001** (grants not enforced) |
| **Hotels / branches / onboarding** | Hotel registration, branches, branch memberships, hotel settings | `src/app/api/hotels/*`, `branches/*`, `src/components/app/branches-view.tsx` | SUPER_ADMIN / owner | `phase10-saas` | NOT AUDITED (tenant isolation not verified) |
| **SaaS subscriptions & plans** | Plans, subscriptions, actions (suspend/cancel), usage metering, entitlements, limits, coupons, refunds, backups | `src/app/api/super-admin/{plans,subscriptions,coupons,refunds,billing,usage}`, `src/lib/saas/*` | SUPER_ADMIN | `phase10-saas`, `phase14-billing`, `billing-outbox` | NOT AUDITED · refund and reconcile logic not reviewed |
| **Billing webhook (SaaS)** | Provider webhook for subscription events (`[provider]`) | `src/app/api/billing/webhook/[provider]/route.ts` | signature | `billing-outbox` | Signature present (not reviewed in depth) |
| **Superadmin platform** | Stats, hotels list, hotels suspend/activate, SaaS KPIs, security actions (force logout, suspend user), audit, support sessions, feature flags, settings, secret rotations, announcements, templates | `src/app/api/super-admin/*`, `src/lib/super-admin.ts` (790 lines) | SUPER_ADMIN (DB-verified after SEC-002) | `super-admin-platform` | Partially reviewed (guard only) |
| **Customers / CRM** | List, create, detail, update, delete, consent, opt-out, visits, timeline, RFM segments, lead scoring | `src/app/api/customers/*`, `visits/*`, `timeline`, `segments/*`, `scoring`, `src/lib/segments.ts`, `scoring.ts` | marketing/front desk | `phase15-retention`, `privacy-phone` | NOT AUDITED (consent path not reviewed) |
| **Import / export** | CSV import with preview/commit (`/api/imports/customers`, `/api/imports/visits`), customer export (inline vs. job), export quota | `src/app/api/imports/*` (customers, visits; preview + commit), `export/*`, `src/lib/import.ts`, `csv.ts`, `csv-guard.ts`, `export-customers.ts` | marketing/owner | `export-quota`, `unit` | NOT AUDITED · CSV-injection guard present (`csv-guard.ts`) |
| **Privacy requests** | Data export/deletion (privacy) | `src/lib/privacy.ts` (revokes all sessions, line ~167) | owner | `privacy-phone` | NOT AUDITED |
| **Campaigns** | Create, update, archive, send (inline or queued), attribution to booking | `src/app/api/campaigns/*`, `src/lib/campaigns.ts` | MARKETING_MANAGER | `phase7`, `recheck-fixes` | NOT AUDITED · consent recheck before send not verified |
| **Automations / journeys / follow-ups** | Automation rules, run endpoint, journeys and enrollments, follow-up steps | `src/app/api/automations/*`, `journeys/*`, `follow-ups/*`, `src/lib/automations.ts` | marketing | `phase15-retention` | NOT AUDITED |
| **Templates** | Message templates CRUD, super-admin templates | `src/app/api/templates/*`, `src/lib/templates.ts` | marketing | — | NOT AUDITED |
| **Menu** | Categories, items (archive, availability), option groups, public menu, voice ordering | `src/app/api/menu/*`, `public/menu/*`, `src/lib/menu.ts` | MENU_MANAGE / MENU_AVAILABILITY | `phase12-menu` | Partially reviewed (item PATCH tenant-scoped) |
| **Tables & table sessions** | Tables CRUD (soft delete), table sessions | `src/app/api/tables/*` | TABLE_MANAGE | — | NOT AUDITED |
| **QR codes / public pages** | QR codes CRUD, public QR resolve (`/r/[code]`), feedback | `src/app/api/qr-codes/*`, `public/qr/*`, `public/feedback`, `src/lib/qr.ts` | owner/marketing | `phase16-operations` | Partially reviewed (public QR GET) |
| **Orders (dine-in & public)** | Staff orders, order events, KDS, public ordering by token, public menu orders | `src/app/api/orders/*`, `public/orders/*`, `src/lib/orders.ts`, `kds` | ORDER_* | `phase13-orders` | NOT AUDITED · server-side price calc not verified |
| **Reservations** | Reservation CRUD and table allocation | `src/app/api/reservations/*`, `src/lib/reservations.ts` | RESERVATION_MANAGE | — | NOT AUDITED |
| **Bills / payments / refunds** | Bills, manual pay, tax rules, cash sessions, payment links, Razorpay checkout and verify, restaurant webhook | `src/app/api/bills/*`, `tax-rules/*`, `pay/[token]/*`, `restaurant-payments/*`, `webhooks/razorpay-restaurant`, `src/lib/billing.ts`, `restaurant.ts` | BILL_* / CASH_SESSION_MANAGE | `phase14-billing` | **Known defect FIN-001 fixed**; rest NOT AUDITED |
| **Loyalty / coupons / referrals / promotions** | Loyalty accounts and rewards, coupons, referral codes, promotions | `src/app/api/loyalty/*`, `coupons/*`, `referrals/*`, `promotions/*`, `src/lib/loyalty.ts` | marketing | `phase16-operations`, `phase64` | NOT AUDITED |
| **Inventory** | Ingredients, recipes, stock movements, stock counts, purchase orders, suppliers | `src/app/api/inventory/*`, `src/lib/inventory.ts` | INVENTORY_MANAGE | — | NOT AUDITED |
| **Attendance / shifts** | Attendance clock records, shift assignments | `src/app/api/attendance`, `shifts`, `src/components/app/attendance-view.tsx` | ATTENDANCE_* | — | NOT AUDITED |
| **Integrations** | Integration CRUD (encrypted credentials), verify, webhook delivery log, replay, outbound webhooks | `src/app/api/integrations/*`, `webhooks/*`, `src/lib/integration-secrets.ts`, `crypto.ts`, `webhooks-out.ts` | INTEGRATION_MANAGE (owner/admin) | `crypto-rotation`, `ops-reliability` | NOT AUDITED (encryption at rest partly tested by `crypto-rotation`: 11 pass) |
| **API keys (tenant)** | Create, list, revoke (`/api/api-keys`), enterprise API v1 proxy | `src/app/api/api-keys/*`, `src/app/api/v1/[...path]`, `src/lib/api-keys.ts`, `enterprise-api.ts` | SETTINGS_MANAGE | `phase17-enterprise` | Partially reviewed (revoke is tenant-scoped) · v1 proxy NOT AUDITED |
| **Analytics / reports / retention** | Overview, RFM, retention alerts, owner reports, sweeps | `src/app/api/analytics/*`, `reports/*`, `src/lib/analytics.ts`, `retention.ts`, `report-sweep.ts` | ANALYTICS_READ / REPORT_MANAGE | `phase15-retention` | NOT AUDITED |
| **AI** | AI settings, conversations, recommendations, forecasts, sustainability, voice parse, WhatsApp webhook | `src/app/api/ai/*`, `src/lib/ai/*` | AI_READ / AI_MANAGE | `phase18-ai` | NOT AUDITED · WhatsApp webhook signature not verified in this pass |
| **Notifications / audit logs** | Notification feed, audit log viewer | `src/app/api/notifications`, `audit-logs`, `src/lib/audit.ts` | AUDIT_LOG_READ | `ops-reliability` | NOT AUDITED |
| **Background jobs / worker** | Job queue, scheduler, heartbeat, `worker.ts`, backup scheduling | `scripts/worker.ts`, `src/lib/queue.ts`, `scheduler.ts`, `src/lib/jobs/handlers.ts`, `worker-heartbeat.ts` | system | `queue-reliability`, `phase11-scheduler`, `backup-schedule` | NOT AUDITED · worker not run |
| **Backup / restore** | Encrypted backups (`.slbkp.enc`), restore script, schedule | `src/lib/saas/backup.ts`, `scripts/restore-backup.ts`, `docs/BACKUP_AND_RESTORE.md` | SUPER_ADMIN | `backup-schedule`, `restore-args` (8 pass) | Blocked (no DB); test mode writes a fake dump |
| **Health / readiness** | `/api/health`, `/api/health/live` | `src/app/api/health/*` | public | — | Source present |
| **Pricing (public)** | `/api/pricing` | `src/app/api/pricing/route.ts` | public | — | Source present |
| **Dashboard / staff UI** | Dashboard, app shell, navigation, views (54 components) | `src/components/app/*` | role-filtered nav | `navigation-rbac` (blocked) | NOT AUDITED (no browser) |
| **Public pages** | `/menu/[code]`, `/r/[code]`, `/pay/[token]`, activate, verify-email, reset-password, forgot-password | `src/app/**/page.tsx` | public | — | NOT AUDITED (no browser) |
| **White-label / domain** | `/api/white-label`, `/domain`, `/verify` | `src/app/api/white-label/*`, `src/lib/white-label.ts` | owner | — | NOT AUDITED (custom domain verification not reviewed) |
| **Wallet passes** | Loyalty wallet pass GET with HMAC triple, revoke | `src/app/api/wallet/*`, `src/lib/...` | public (HMAC) / owner (revoke) | — | Partially reviewed (HMAC triple required) |
| **Test-only** | `/api/test/mock-emails` | `src/app/api/test/mock-emails/route.ts` | blocked outside test | — | Hardened (SEC-004) |

## Features NOT found in source (absent)
- Missing control, not a feature: rate limiting on the `/api/pay/[token]` routes (SEC-007).
- Impersonation: `super-admin/support` exists, but whether it is an impersonation flow (and whether it is time-limited and audited) was NOT verified.

## Demo-only or blocked-by-config
- Demo seed data (`scripts/seed*.ts`) and fixed demo passwords exist for dev only.
- Email, WhatsApp, Twilio, Razorpay, Stripe: depend on credentials; mock providers exist for tests (`providers/email.ts`).
