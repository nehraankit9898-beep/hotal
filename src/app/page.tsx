"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Providers } from "@/components/app/providers";
import { LoginScreen } from "@/components/app/login-screen";
import { RegisterScreen } from "@/components/app/register-screen";
import { ActivateScreen } from "@/components/app/activate-screen";
import { AppShell } from "@/components/app/app-shell";
import { DashboardView } from "@/components/app/dashboard-view";
import { CustomersView } from "@/components/app/customers-view";
import { CustomerProfileView } from "@/components/app/customer-profile-view";
import { VisitsView } from "@/components/app/visits-view";
import { ImportView } from "@/components/app/import-view";
import { ComingSoonView } from "@/components/app/coming-soon-view";
import { AuditView } from "@/components/app/audit-view";
import { SettingsView } from "@/components/app/settings-view";
import { SegmentsView } from "@/components/app/segments-view";
import { CampaignsView } from "@/components/app/campaigns-view";
import { AnalyticsView } from "@/components/app/analytics-view";
// Phase 3-6 views
import { CouponsView } from "@/components/app/coupons-view";
import { AutomationsView } from "@/components/app/automations-view";
import { RestaurantView } from "@/components/app/restaurant-view";
import { RestaurantLeaderboardView } from "@/components/app/restaurant-leaderboard-view";
import { ScoringView } from "@/components/app/scoring-view";
import { LeadsView } from "@/components/app/leads-view";
import { IntegrationsView } from "@/components/app/integrations-view";
import { SuperAdminView } from "@/components/app/super-admin-view";
// Phase 10 views
import { BillingView } from "@/components/app/billing-view";
import {
  SaasPlansTab,
  SaasSubscriptionsTab,
  SaasCouponsTab,
  SaasFlagsTab,
  SaasBillingTab,
  SaasUsageTab,
  SaasSecurityTab,
  SaasBackupsTab,
  SaasTemplatesTab,
  SaasSettingsTab,
} from "@/components/app/super-admin-saas";
// Phase 6.3 views
import { LoyaltyView } from "@/components/app/loyalty-view";
import { QrCodesView } from "@/components/app/qr-codes-view";
import { FeedbackView } from "@/components/app/feedback-view";
import { TemplatesView } from "@/components/app/templates-view";
// Phase 11 views
import { DeveloperView } from "@/components/app/developer-view";
import { NotificationsView } from "@/components/app/notifications-view";
import { JourneysView } from "@/components/app/journeys-view";
// Phase 12/13 views
import { MenuView } from "@/components/app/menu-view";
import { TablesView } from "@/components/app/tables-view";
import { OrdersView } from "@/components/app/orders-view";
import { KdsView } from "@/components/app/kds-view";
import { PosView } from "@/components/app/pos-view";
import { BillsView } from "@/components/app/bills-view";
import { TaxRulesView } from "@/components/app/tax-rules-view";
import { PromotionsView } from "@/components/app/promotions-view";
import { ReferralsView } from "@/components/app/referrals-view";
import { ReportsView } from "@/components/app/reports-view";
import { ReservationsView } from "@/components/app/reservations-view";
import { InventoryView } from "@/components/app/inventory-view";
import { AttendanceView } from "@/components/app/attendance-view";
import { BranchesView } from "@/components/app/branches-view";
import { AiView } from "@/components/app/ai-view";
import { StaffView } from "@/components/app/staff-view";
import { api, clearSessionToken } from "@/lib/api-client";
import type { SessionUser, ViewId } from "@/lib/types";
import { Hotel } from "lucide-react";

function App() {
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<"login" | "register">("login");
  const [view, setView] = useState<ViewId>("dashboard");
  const [profileCustomerId, setProfileCustomerId] = useState<string | null>(null);

  // Phase 3: owner invitation activation (/activate?token=...)
  const [activation, setActivation] = useState<{ token: string } | null>(null);
  if (
    typeof window !== "undefined" &&
    activation === null &&
    window.location.pathname === "/activate"
  ) {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setActivation({ token });
    }
  }

  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: SessionUser }>("/api/auth/me"),
    retry: false,
  });

  async function handleLogout() {
    try {
      await api.post("/api/auth/logout");
    } catch {
      // best-effort
    }
    clearSessionToken();
    setView("dashboard");
    setProfileCustomerId(null);
    queryClient.setQueryData(["me"], null);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  }

  function openCustomer(id: string) {
    setProfileCustomerId(id);
  }

  function closeCustomer() {
    setProfileCustomerId(null);
  }

  function switchView(v: ViewId) {
    setProfileCustomerId(null);
    setView(v);
  }

  // Splash while checking session
  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground animate-pulse">
          <Hotel className="h-7 w-7" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">Loading RestroLoop…</p>
      </div>
    );
  }

  const user = data?.user ?? null;

  // Auth screens
  if (activation) {
    return (
      <ActivateScreen
        token={activation.token}
        onActivated={() => {
          window.location.replace("/");
          setActivation(null);
        }}
      />
    );
  }

  if (!user) {
    return screen === "login" ? (
      <LoginScreen
        onLoggedIn={() => queryClient.invalidateQueries({ queryKey: ["me"] })}
        onGoRegister={() => setScreen("register")}
      />
    ) : (
      <RegisterScreen onGoLogin={() => setScreen("login")} />
    );
  }

  // Phase 2: a session flagged mustChangePassword is locked to the Settings
  // (password change) view — the server blocks every other route anyway.
  const forcedChange = user.mustChangePassword === true && view !== "settings";

  // Phase 10 — MFA policy: a session flagged mfaSetupRequired is locked to
  // Settings (MFA enrolment) — the server blocks every other route anyway.
  const forcedMfaSetup = user.mfaSetupRequired === true && view !== "settings";

  // Phase 8.1 §4 — SUPER_ADMIN routing is DETERMINISTIC:
  //  - always lands on the Super Admin Control Center,
  //  - may only use platform views (control center, SaaS console, health,
  //    support, platform audit, notifications, own profile),
  //  - any hotel-only ViewId renders the Control Center instead of
  //    hotel-scoped components. Backend guards stay authoritative; this is UX.
  const SUPER_ADMIN_ALLOWED: ReadonlySet<ViewId> = new Set([
    "super_admin",
    "system_health",
    "support",
    "notifications",
    "audit", // platform audit (SuperAdminView audit tab / platform API)
    "settings", // profile-only (hotel settings gated out in SettingsView + API)
    // Phase 10 — SaaS console views
    "sa_plans",
    "sa_subscriptions",
    "sa_coupons",
    "sa_flags",
    "sa_billing",
    "sa_usage",
    "sa_security",
    "sa_backups",
    "sa_templates",
    "sa_settings",
  ]);

  let effectiveView: ViewId = view;
  if (forcedChange || forcedMfaSetup) {
    effectiveView = "settings";
  } else if (user.role === "SUPER_ADMIN") {
    effectiveView = SUPER_ADMIN_ALLOWED.has(view) ? view : "super_admin";
  }

  // Customer profile view (overrides regular views)
  const showProfile = profileCustomerId !== null;

  return (
    <AppShell user={user} onLogout={handleLogout} view={effectiveView} setView={switchView}>
      {showProfile ? (
        <CustomerProfileView
          customerId={profileCustomerId}
          onBack={closeCustomer}
          setView={setView}
        />
      ) : effectiveView === "dashboard" ? (
        <DashboardView user={user} setView={switchView} onOpenCustomer={openCustomer} />
      ) : effectiveView === "customers" ? (
        <CustomersView onOpenCustomer={openCustomer} setView={switchView} />
      ) : effectiveView === "visits" ? (
        <VisitsView onOpenCustomer={openCustomer} />
      ) : effectiveView === "segments" ? (
        <SegmentsView onOpenCustomer={openCustomer} />
      ) : effectiveView === "campaigns" ? (
        <CampaignsView user={user} onOpenCustomer={openCustomer} />
      ) : effectiveView === "analytics" ? (
        <AnalyticsView />
      ) : effectiveView === "import" ? (
        <ImportView />
      ) : effectiveView === "audit" ? (
        user.role === "SUPER_ADMIN" ? (
          // Phase 8.1 §3: platform-wide audit for the operator
          <SuperAdminView initialTab="audit" />
        ) : (
          <AuditView />
        )
      ) : effectiveView === "settings" ? (
        <SettingsView user={user} />
      ) : effectiveView === "coupons" ? (
        <CouponsView />
      ) : effectiveView === "automations" ? (
        <AutomationsView />
      ) : effectiveView === "scoring" ? (
        <ScoringView />
      ) : effectiveView === "leads" ? (
        <LeadsView />
      ) : effectiveView === "integrations" ? (
        <IntegrationsView />
      ) : effectiveView === "restaurant" ? (
        <RestaurantView />
      ) : effectiveView === "restaurant_leaderboard" ? (
        <RestaurantLeaderboardView />
      ) : effectiveView === "super_admin" ? (
        <SuperAdminView />
      ) : effectiveView === "system_health" ? (
        <SuperAdminView initialTab="health" />
      ) : effectiveView === "support" ? (
        <SuperAdminView initialTab="support" />
      ) : effectiveView === "notifications" ? (
        // Bug fix: hotel roles get the real notifications view — previously this
        // rendered the Super Admin Control Center (wrong component).
        <NotificationsView />
      ) : effectiveView === "api" ? (
        <DeveloperView />
      ) : effectiveView === "journeys" ? (
        <JourneysView />
      ) : effectiveView === "sa_plans" ? (
        <SaasPlansTab />
      ) : effectiveView === "sa_subscriptions" ? (
        <SaasSubscriptionsTab />
      ) : effectiveView === "sa_coupons" ? (
        <SaasCouponsTab />
      ) : effectiveView === "sa_flags" ? (
        <SaasFlagsTab />
      ) : effectiveView === "sa_billing" ? (
        <SaasBillingTab />
      ) : effectiveView === "sa_usage" ? (
        <SaasUsageTab />
      ) : effectiveView === "sa_security" ? (
        <SaasSecurityTab />
      ) : effectiveView === "sa_backups" ? (
        <SaasBackupsTab />
      ) : effectiveView === "sa_templates" ? (
        <SaasTemplatesTab />
      ) : effectiveView === "sa_settings" ? (
        <SaasSettingsTab />
      ) : effectiveView === "billing" ? (
        <BillingView />
      ) : effectiveView === "loyalty" ? (
        <LoyaltyView />
      ) : effectiveView === "qr_codes" ? (
        <QrCodesView />
      ) : effectiveView === "feedback" ? (
        <FeedbackView />
      ) : effectiveView === "templates" ? (
        <TemplatesView />
      ) : effectiveView === "menu" ? (
        <MenuView user={user} />
      ) : effectiveView === "tables" ? (
        <TablesView user={user} />
      ) : effectiveView === "orders" ? (
        <OrdersView user={user} />
      ) : effectiveView === "kds" ? (
        <KdsView />
      ) : effectiveView === "staff" ? (
        <StaffView user={user} />
      ) : effectiveView === "pos" ? (
        <PosView user={user} />
      ) : effectiveView === "bills" ? (
        <BillsView user={user} />
      ) : effectiveView === "tax_rules" ? (
        <TaxRulesView />
      ) : effectiveView === "promotions" ? (
        <PromotionsView />
      ) : effectiveView === "referrals" ? (
        <ReferralsView />
      ) : effectiveView === "reports" ? (
        <ReportsView />
      ) : effectiveView === "reservations" ? (
        <ReservationsView />
      ) : effectiveView === "inventory" ? (
        <InventoryView />
      ) : effectiveView === "attendance" ? (
        <AttendanceView />
      ) : effectiveView === "branches" ? (
        <BranchesView />
      ) : effectiveView === "ai" ? (
        <AiView user={user} />
      ) : (
        <ComingSoonView view={view} />
      )}
    </AppShell>
  );
}

export default function Page() {
  return (
    <Providers>
      <App />
    </Providers>
  );
}
