"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SessionUser, ViewId } from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";
import { initials } from "@/lib/format";
import {
  Hotel,
  LayoutDashboard,
  Users,
  UsersRound,
  CalendarCheck,
  Upload,
  Trophy,
  Send,
  BarChart3,
  ScrollText,
  Settings,
  LogOut,
  Menu,
  Sun,
  MoonStar,
  UserCog,
  ChevronRight,
  // Phase 3-6 icons
  Ticket,
  Bot,
  Utensils,
  Flame,
  Plug,
  Bell,
  ShieldCheck,
  Activity,
  // Phase 6.3 icons
  Gift,
  QrCode,
  MessageSquareText,
  Star,
  // Phase 10 icons
  IndianRupee,
  RefreshCw,
  Flag,
  CreditCard,
  Lock,
  DatabaseBackup,
  // Phase 11 icons
  Code2,
  Route,
  // Phase 12/13 icons
  ChefHat,
  ClipboardList,
  BookOpen,
  LayoutGrid,
  // Phase 14/15/16 icons
  Receipt,
  ReceiptText,
  Percent,
  Megaphone,
  CalendarClock,
  Package,
  Clock,
  Building2,
  Sparkles,
} from "lucide-react";

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  soon?: boolean;
}

const NAV_MAIN: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "customers", label: "Customers", icon: Users },
  { id: "segments", label: "Segments", icon: UsersRound },
  { id: "visits", label: "Visits", icon: CalendarCheck },
  { id: "campaigns", label: "Campaigns", icon: Send },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "import", label: "Import Data", icon: Upload },
];

const NAV_INTELLIGENCE: NavItem[] = [
  // Phase 3
  { id: "scoring", label: "Lead Scoring", icon: Flame },
  { id: "coupons", label: "Coupons", icon: Ticket },
  { id: "automations", label: "Automations", icon: Bot },
  { id: "journeys", label: "Journeys", icon: Route },
  // Phase 4
  { id: "leads", label: "Engagement", icon: Activity },
  { id: "integrations", label: "Integrations", icon: Plug },
];

const NAV_RESTAURANT: NavItem[] = [
  // Phase 5
  { id: "restaurant", label: "Restaurant Visits", icon: Utensils },
  { id: "restaurant_leaderboard", label: "Diner Leaderboard", icon: Trophy },
];

// Phase 12/13 — restaurant OPERATIONS section (menu, floor, kitchen, staff).
// Role-filtered: kitchen staff see ONLY the KDS; waiters see floor + orders;
// cashiers see orders; managers/owners see everything. The API enforces the
// same matrix server-side — this is UX, not the guard.
const NAV_OPERATIONS: NavItem[] = [
  { id: "orders", label: "Orders", icon: ClipboardList },
  { id: "kds", label: "Kitchen Display", icon: ChefHat },
  { id: "menu", label: "Digital Menu", icon: BookOpen },
  { id: "tables", label: "Tables & QR", icon: LayoutGrid },
  { id: "staff", label: "Staff", icon: UserCog },
];

// Phase 14/15/16 — POS & Operations sections (role-filtered, same policy as
// above: hiding is UX, the API permission matrix is the real guard).
const NAV_POS: NavItem[] = [
  { id: "pos", label: "POS Terminal", icon: Receipt },
  { id: "bills", label: "Bills & Refunds", icon: ReceiptText },
  { id: "tax_rules", label: "GST & Tax Rules", icon: Percent },
];

const NAV_RETENTION: NavItem[] = [
  { id: "promotions", label: "Promotions", icon: Megaphone },
  { id: "referrals", label: "Referrals", icon: Users },
  { id: "reports", label: "Owner Reports", icon: BarChart3 },
];

const NAV_OPS16: NavItem[] = [
  { id: "reservations", label: "Reservations", icon: CalendarClock },
  { id: "inventory", label: "Inventory", icon: Package },
  { id: "attendance", label: "Attendance & Shifts", icon: Clock },
  { id: "branches", label: "Branch Dashboard", icon: Building2 },
];

// Phase 18 — AI console (role-filtered: AI_READ holders — owner/admin/manager/
// marketing; the API enforces the same matrix server-side).
const NAV_AI: NavItem[] = [
  { id: "ai", label: "AI Assistant", icon: Sparkles },
];

const POS_NAV_ROLES: Record<string, ReadonlySet<string>> = {
  pos: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "CASHIER"]),
  bills: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "CASHIER", "WAITER"]),
  tax_rules: new Set(["HOTEL_OWNER", "HOTEL_ADMIN"]),
};

const RETENTION_NAV_ROLES: Record<string, ReadonlySet<string>> = {
  promotions: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "MARKETING_MANAGER"]),
  referrals: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "MARKETING_MANAGER"]),
  reports: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "MARKETING_MANAGER"]),
};

const AI_NAV_ROLES: Record<string, ReadonlySet<string>> = {
  ai: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "MARKETING_MANAGER"]),
};

const OPS16_NAV_ROLES: Record<string, ReadonlySet<string>> = {
  reservations: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "WAITER", "CASHIER", "FRONT_DESK"]),
  inventory: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "KITCHEN_STAFF"]),
  attendance: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "WAITER", "CASHIER", "KITCHEN_STAFF"]),
  branches: new Set(["HOTEL_OWNER", "HOTEL_ADMIN"]),
};

function posNavFor(role: string): NavItem[] {
  return NAV_POS.filter((item) => POS_NAV_ROLES[item.id]?.has(role));
}
function retentionNavFor(role: string): NavItem[] {
  return NAV_RETENTION.filter((item) => RETENTION_NAV_ROLES[item.id]?.has(role));
}
function ops16NavFor(role: string): NavItem[] {
  return NAV_OPS16.filter((item) => OPS16_NAV_ROLES[item.id]?.has(role));
}
function aiNavFor(role: string): NavItem[] {
  return NAV_AI.filter((item) => AI_NAV_ROLES[item.id]?.has(role));
}

/** Which roles may see each operations nav item (mirrors server permissions). */
const OPERATIONS_NAV_ROLES: Record<string, ReadonlySet<string>> = {
  orders: new Set([
    "HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER",
    "FRONT_DESK", "WAITER", "CASHIER", "HOTEL_STAFF",
  ]),
  kds: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "KITCHEN_STAFF"]),
  menu: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "KITCHEN_STAFF", "WAITER", "CASHIER"]),
  tables: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER", "FRONT_DESK", "WAITER"]),
  staff: new Set(["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER"]),
};

function operationsNavFor(role: string): NavItem[] {
  return NAV_OPERATIONS.filter((item) => OPERATIONS_NAV_ROLES[item.id]?.has(role));
}

const NAV_GROWTH: NavItem[] = [
  // Phase 6.3 — restaurant growth
  { id: "loyalty", label: "Loyalty Program", icon: Gift },
  { id: "qr_codes", label: "QR Codes", icon: QrCode },
  { id: "templates", label: "Message Templates", icon: MessageSquareText },
  { id: "feedback", label: "Feedback", icon: Star },
];

const NAV_PLATFORM: NavItem[] = [
  // Phase 6/10 — SUPER_ADMIN ONLY (Phase 8.1 §2): this section is never rendered
  // for hotel roles — not hidden with CSS, simply not rendered at all.
  { id: "super_admin", label: "Dashboard", icon: ShieldCheck },
  { id: "sa_plans", label: "Plans & Pricing", icon: IndianRupee },
  { id: "sa_subscriptions", label: "Subscriptions & Trials", icon: RefreshCw },
  { id: "sa_coupons", label: "Coupons", icon: Ticket },
  { id: "sa_flags", label: "Feature Flags", icon: Flag },
  { id: "sa_billing", label: "Billing", icon: CreditCard },
  { id: "sa_usage", label: "Usage & Limits", icon: BarChart3 },
  { id: "sa_security", label: "Security Centre", icon: Lock },
  { id: "sa_backups", label: "Backups", icon: DatabaseBackup },
  { id: "system_health", label: "System Health", icon: Activity },
  { id: "support", label: "Support Sessions", icon: Bell },
];

const NAV_ADMIN: NavItem[] = [
  // Hotel-scoped administration (hotel roles only)
  { id: "audit", label: "Audit Logs", icon: ScrollText },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "billing", label: "Billing & Plan", icon: CreditCard },
  { id: "api", label: "API & Developers", icon: Code2 },
  { id: "settings", label: "Settings", icon: Settings },
];

/**
 * Roles allowed to manage API keys / developer settings (matches the server
 * permission matrix — SETTINGS_MANAGE is held by OWNER/ADMIN only). The nav
 * item is hidden for roles the API would reject with 403.
 */
const API_NAV_ROLES: ReadonlySet<string> = new Set(["HOTEL_OWNER", "HOTEL_ADMIN"]);

/** Role-filter the admin nav so hidden items never 403 (UX, not the guard). */
function adminNavFor(role: string): NavItem[] {
  return NAV_ADMIN.filter((item) => item.id !== "api" || API_NAV_ROLES.has(role));
}

const NAV_PLATFORM_ADMIN: NavItem[] = [
  // Phase 8.1 §3 + Phase 10: SUPER_ADMIN platform administration — NO hotel
  // Settings (tenant-scoped hotel settings must never appear for the operator).
  { id: "sa_templates", label: "Notification Templates", icon: MessageSquareText },
  { id: "audit", label: "Platform Audit Logs", icon: ScrollText },
  { id: "sa_settings", label: "Platform Settings", icon: Settings },
];

const NAV_SOON: NavItem[] = [];

const VIEW_TITLES: Record<ViewId, { title: string; subtitle: string }> = {
  dashboard: { title: "Dashboard", subtitle: "Your hotel's retention at a glance" },
  customers: { title: "Customers", subtitle: "Every guest, one searchable list" },
  segments: { title: "Segments", subtitle: "Smart guest groups, built automatically" },
  visits: { title: "Visits", subtitle: "Check-ins recorded across your hotel" },
  campaigns: { title: "Campaigns", subtitle: "Personalised offers, consent-first" },
  analytics: { title: "Analytics", subtitle: "Campaign performance and revenue" },
  import: { title: "Import Data", subtitle: "Bring your guest list in from CSV" },
  leaderboard: { title: "Leaderboard", subtitle: "Your most loyal guests" },
  audit: { title: "Audit Logs", subtitle: "Every important action, recorded" },
  settings: { title: "Settings", subtitle: "Your account and hotel profile" },
  // Phase 3
  scoring: { title: "Lead Scoring", subtitle: "RFM + lead tier for every customer" },
  coupons: { title: "Coupons", subtitle: "Discount codes, redemption limits, attribution" },
  automations: { title: "Automations", subtitle: "Trigger → wait → condition → action" },
  journeys: { title: "Customer Journeys", subtitle: "Automated follow-up day plans" },
  // Phase 4
  leads: { title: "Engagement Events", subtitle: "Opens, clicks, replies feeding lead score" },
  integrations: { title: "Integrations", subtitle: "WhatsApp, SMS, Email, payments, POS" },
  // Phase 5
  restaurant: { title: "Restaurant Customers", subtitle: "Diners, walk-ins, online orders" },
  restaurant_leaderboard: {
    title: "Diner Leaderboard",
    subtitle: "Top restaurant customers by spend",
  },
  // Phase 6
  super_admin: {
    title: "Super Admin Control Center",
    subtitle: "Multi-tenant platform management",
  },
  system_health: { title: "System Health", subtitle: "Subsystem status and uptime" },
  support: { title: "Support Sessions", subtitle: "Time-limited admin access logs" },
  notifications: { title: "Notifications", subtitle: "Platform alerts for your hotel" },
  // Phase 10 — Super Admin SaaS console
  sa_plans: { title: "Plans & Pricing", subtitle: "Dynamic plans, prices, features and limits" },
  sa_subscriptions: {
    title: "Subscriptions & Trials",
    subtitle: "Tenant lifecycle: trials, renewals, upgrades",
  },
  sa_coupons: { title: "Billing Coupons", subtitle: "Checkout discounts with usage controls" },
  sa_flags: { title: "Feature Flags", subtitle: "Global defaults, overrides and kill switches" },
  sa_billing: { title: "Billing", subtitle: "Providers, payments, invoices and refunds" },
  sa_usage: { title: "Usage & Limits", subtitle: "Platform-wide resource consumption" },
  sa_security: {
    title: "Security Centre",
    subtitle: "Threats, sessions, MFA policy and IP controls",
  },
  sa_backups: { title: "Backups", subtitle: "Encrypted backups, verification and retention" },
  sa_templates: {
    title: "Notification Templates",
    subtitle: "Trial, billing and security messages",
  },
  sa_settings: { title: "Platform Settings", subtitle: "Trial defaults, maintenance and policies" },
  billing: { title: "Billing & Plan", subtitle: "Your subscription, usage and invoices" },
  // Phase 6.3
  loyalty: { title: "Loyalty Program", subtitle: "Points, tiers and rewards your customers love" },
  qr_codes: { title: "QR Codes", subtitle: "Table codes that bring customers in" },
  feedback: { title: "Feedback", subtitle: "Star ratings straight from your tables" },
  templates: { title: "Message Templates", subtitle: "Ready-made messages for every occasion" },
  // Phase 11
  api: { title: "API & Developers", subtitle: "API keys and REST reference for your apps" },
  // Phase 12/13 — restaurant operations
  orders: { title: "Orders", subtitle: "Live order stream from QR diners and staff" },
  kds: { title: "Kitchen Display", subtitle: "Live kitchen queue — new, preparing, ready" },
  menu: { title: "Digital Menu", subtitle: "Categories, items and pricing on your QR menu" },
  tables: { title: "Tables & QR", subtitle: "Your floor map and table ordering codes" },
  staff: { title: "Staff", subtitle: "Invite your team and manage their roles" },
  // Phase 14/15/16
  pos: { title: "POS Terminal", subtitle: "Create bills, take split/mixed payments, print receipts" },
  bills: { title: "Bills & Refunds", subtitle: "Invoice history, refunds and voids — audited" },
  tax_rules: { title: "GST & Tax Rules", subtitle: "Effective-dated CGST/SGST/IGST configuration" },
  promotions: { title: "Promotions", subtitle: "Happy hours, combos and offers" },
  referrals: { title: "Referrals", subtitle: "Both-side rewards after a qualifying first visit" },
  reports: { title: "Owner Reports", subtitle: "Business-day sales and email digests" },
  reservations: { title: "Reservations", subtitle: "Table bookings with slot conflict protection" },
  inventory: { title: "Inventory", subtitle: "Stock ledger, recipes and wastage" },
  attendance: { title: "Attendance & Shifts", subtitle: "Clock in/out, corrections and shift plans" },
  branches: { title: "Branch Dashboard", subtitle: "Consolidated view across your branch group" },
  ai: { title: "AI Assistant", subtitle: "Rule-based automation, forecasting and ordering — human-approved" },
};

function NotificationsBell({ setView }: { setView: (v: ViewId) => void }) {
  const { data } = useQuery({
    queryKey: ["notifications-unread"],
    queryFn: () => api.get<{ unreadCount: number }>("/api/notifications?unread=true"),
    refetchInterval: 60_000,
    retry: false,
  });
  const unread = data?.unreadCount ?? 0;
  return (
    <button
      type="button"
      onClick={() => setView("notifications")}
      className="relative rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
      title="Notifications"
    >
      <Bell className="h-[18px] w-[18px]" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9.5px] font-bold text-destructive-foreground">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

function SidebarNav({
  view,
  setView,
  user,
  onLogout,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
  user: SessionUser;
  onLogout: () => void;
}) {
  function renderGroup(items: NavItem[], heading?: string) {
    return (
      <div className="px-3">
        {heading && (
          <p className="px-3 mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40">
            {heading}
          </p>
        )}
        <nav className="space-y-1">
          {items.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={cn(
                  "w-full group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <item.icon className={cn("h-[18px] w-[18px] shrink-0", !active && "opacity-80")} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.soon && (
                  <span className="rounded-full bg-sidebar-foreground/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-sidebar-foreground/50">
                    Soon
                  </span>
                )}
                {active && !item.soon && <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 pt-6 pb-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
          <Hotel className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[15px] font-bold tracking-tight leading-tight">RestroLoop</p>
          <p className="text-[10.5px] text-sidebar-foreground/50 truncate">
            {user.hotelName || "Platform Control Centre"}
          </p>
        </div>
      </div>

      {/* Nav — role-scoped (Phase 8.1 §2/§3): the platform section is rendered
          ONLY for SUPER_ADMIN. Hotel roles never see Super Admin, System Health
          or Support Sessions. SUPER_ADMIN never sees hotel Settings. */}
      <div className="flex-1 overflow-y-auto space-y-5 py-2 pb-6">
        {user.role === "SUPER_ADMIN" ? (
          <>
            {renderGroup(NAV_PLATFORM, "Platform Control")}
            {renderGroup(NAV_PLATFORM_ADMIN, "Administration")}
          </>
        ) : (
          <>
            {renderGroup(NAV_MAIN)}
            {renderGroup(NAV_INTELLIGENCE, "Intelligence & Growth")}
            {renderGroup(NAV_GROWTH, "Growth")}
            {renderGroup(NAV_RESTAURANT, "Restaurant")}
            {renderGroup(operationsNavFor(user.role), "Restaurant Operations")}
            {renderGroup(posNavFor(user.role), "POS & Billing")}
            {renderGroup(retentionNavFor(user.role), "Retention & Marketing")}
            {renderGroup(ops16NavFor(user.role), "Operations")}
            {renderGroup(aiNavFor(user.role), "AI Assistant")}
            {renderGroup(adminNavFor(user.role), "Administration")}
          </>
        )}
      </div>

      {/* User card */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <Avatar className="h-9 w-9 border border-sidebar-border">
            <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground text-xs font-semibold">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-tight">{user.name}</p>
            <p className="truncate text-[11px] text-sidebar-foreground/50">
              {ROLE_LABELS[user.role] ?? user.role}
            </p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg p-2 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppShell({
  user,
  onLogout,
  children,
  view,
  setView,
}: {
  user: SessionUser;
  onLogout: () => void;
  children: React.ReactNode;
  view: ViewId;
  setView: (v: ViewId) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  // Phase 8.1: role-aware page titles for shared ViewIds
  const meta =
    user.role === "SUPER_ADMIN" && view === "audit"
      ? { title: "Platform Audit Logs", subtitle: "Every sensitive action across all hotels" }
      : user.role === "SUPER_ADMIN" && view === "settings"
        ? { title: "Profile & Account", subtitle: "Your platform operator account" }
        : VIEW_TITLES[view];

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[264px] lg:block">
        <SidebarNav view={view} setView={setView} user={user} onLogout={onLogout} />
      </aside>

      {/* Main column */}
      <div className="lg:pl-[264px] flex min-h-screen flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/85 backdrop-blur px-4 sm:px-6">
          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[280px] p-0 border-0">
              <SheetTitle className="sr-only">Navigation menu</SheetTitle>
              <SheetDescription className="sr-only">
                Main navigation for your hotel workspace
              </SheetDescription>
              <SidebarNav
                view={view}
                setView={(v) => {
                  setView(v);
                  setMobileOpen(false);
                }}
                user={user}
                onLogout={onLogout}
              />
            </SheetContent>
          </Sheet>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-bold tracking-tight leading-tight">
              {meta.title}
            </h1>
            <p className="hidden sm:block truncate text-xs text-muted-foreground">
              {meta.subtitle}
            </p>
          </div>

          {/* Phase badge */}
          <Badge
            variant="outline"
            className="hidden md:inline-flex items-center gap-1.5 border-primary/40 bg-primary/5 text-primary px-2.5"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Phases 1–10
          </Badge>

          {/* Notifications bell (hotel roles — SUPER_ADMIN has its own console) */}
          {user.role !== "SUPER_ADMIN" && <NotificationsBell setView={setView} />}

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            <Sun className="h-[18px] w-[18px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <MoonStar className="absolute h-[18px] w-[18px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Account menu"
              >
                <Avatar className="h-9 w-9 border">
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="text-sm font-semibold">{user.name}</p>
                <p className="text-xs font-normal text-muted-foreground">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {user.role === "SUPER_ADMIN" ? (
                <DropdownMenuItem onClick={() => setView("audit")}>
                  <ScrollText className="h-4 w-4" /> Platform audit logs
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setView("audit")}>
                  <ScrollText className="h-4 w-4" /> Audit logs
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setView("settings")}>
                <UserCog className="h-4 w-4" /> Profile &amp; account
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onLogout}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Content */}
        <main className="flex-1 mx-auto w-full max-w-[1200px] px-4 sm:px-6 py-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="mt-auto border-t bg-background">
          <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5">
              <Hotel className="h-3.5 w-3.5 text-primary" />
              RestroLoop · {user.hotelName || "Platform Control Centre"}
            </p>
            <p>
              {user.role === "SUPER_ADMIN"
                ? "Platform operator — tenant data stays isolated per hotel."
                : "Guest data is private to your hotel — never shared across hotels."}
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
