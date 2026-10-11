"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DashboardData, SessionUser, ViewId } from "@/lib/types";
import { StatCard, EmptyState } from "./shared-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { formatRelative, formatNumber } from "@/lib/format";
import type { SubscriptionView } from "@/lib/types";
import {
  Users,
  BellRing,
  Ban,
  CalendarCheck,
  UserCheck,
  Repeat,
  ArrowRight,
  UserPlus,
  TrendingUp,
  PieChart as PieIcon,
  Loader2,
  Clock,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

const chartConfig = {
  visits: { label: "Visits", color: "var(--chart-1)" },
} satisfies ChartConfig;

const consentConfig = {
  optedIn: { label: "Opted in", color: "var(--chart-2)" },
  noConsent: { label: "No consent yet", color: "var(--chart-3)" },
  optedOut: { label: "Opted out", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function DashboardView({
  user,
  setView,
  onOpenCustomer,
}: {
  user: SessionUser;
  setView: (v: ViewId) => void;
  onOpenCustomer: (id: string) => void;
}) {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/api/dashboard/stats"),
    refetchInterval: 60_000, // dashboard stays fresh
  });

  // Phase 10 — trial/expiry banner (server-verified subscription state).
  const subscriptionQuery = useQuery({
    queryKey: ["subscription", "self"],
    queryFn: () => api.get<{ subscription: SubscriptionView }>("/api/subscription"),
    retry: false,
  });
  const subscription = subscriptionQuery.data?.subscription;
  const showTrialBanner =
    subscription?.state === "TRIALING" && (subscription.trialDaysRemaining ?? 0) <= 7;
  const showExpiryBanner = subscription?.state === "GRACE" || subscription?.state === "EXPIRED";

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-[300px] rounded-xl lg:col-span-2" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Could not load your dashboard"
        description="We couldn't fetch your statistics right now. This is usually temporary."
        action={
          <Button onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Try again
          </Button>
        }
      />
    );
  }

  const { stats, visitsTrend, recentCustomers, recentVisits } = data;
  const consentData = [
    { key: "optedIn", label: "Opted in", value: stats.marketingOptIn },
    { key: "noConsent", label: "No consent yet", value: stats.noConsent },
    { key: "optedOut", label: "Opted out", value: stats.optedOut },
  ].filter((d) => d.value > 0);

  // Merge recent activity
  const activity = [
    ...recentCustomers.map((c) => ({
      kind: "customer" as const,
      id: c.id,
      name: c.name,
      detail: "New customer added",
      at: c.createdAt,
    })),
    ...recentVisits.map((v) => ({
      kind: "visit" as const,
      id: v.customer.id,
      name: v.customer.name,
      detail: "Visit recorded",
      at: v.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  const trendChartData = visitsTrend.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    visits: d.count,
  }));

  return (
    <div className="space-y-6">
      {/* Phase 10 — trial / expiry banner (server-verified, never client-trusted) */}
      {showTrialBanner && (
        <div className="rounded-xl border border-sky-500/40 bg-sky-500/5 p-4 sm:p-5 flex flex-wrap items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600">
            <Clock className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">
              Trial ending in {subscription?.trialDaysRemaining}{" "}
              {subscription?.trialDaysRemaining === 1 ? "day" : "days"}
              {subscription?.plan ? ` — ${subscription.plan.name} plan` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Keep your campaigns, loyalty program and guest insights after the trial — pick a plan
              in Billing.
            </p>
          </div>
          <Button size="sm" onClick={() => setView("billing")}>
            <Sparkles className="h-4 w-4 mr-1.5" /> Upgrade plan
          </Button>
        </div>
      )}
      {showExpiryBanner && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-4 sm:p-5 flex flex-wrap items-center gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">
              {subscription?.state === "GRACE"
                ? "Grace period — renew now"
                : "Your subscription has expired"}
            </p>
            <p className="text-xs text-muted-foreground">
              {subscription?.state === "GRACE"
                ? `Access continues until ${subscription?.graceEndsAt ? new Date(subscription.graceEndsAt).toLocaleDateString() : "the grace window ends"}.`
                : "Choose a plan to restore full access to your workspace."}
            </p>
          </div>
          <Button size="sm" onClick={() => setView("billing")}>
            View plans
          </Button>
        </div>
      )}
      {/* Welcome strip */}
      <div className="rounded-xl border bg-[linear-gradient(120deg,oklch(0.98_0.02_85),oklch(0.955_0.035_75))] dark:bg-[linear-gradient(120deg,oklch(0.24_0.03_60),oklch(0.28_0.04_55))] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold tracking-tight">
              {greeting()}, {user.name.split(" ")[0]} 👋
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Here&apos;s what&apos;s happening at{" "}
              <span className="font-medium text-foreground">{user.hotelName}</span> today.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="bg-background/60"
              onClick={() => setView("customers")}
            >
              <UserPlus className="h-4 w-4" /> Add customer
            </Button>
            <Button size="sm" onClick={() => setView("import")}>
              Import CSV <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          title="Total Customers"
          value={stats.totalCustomers}
          icon={Users}
          tone="default"
          delay={0}
        />
        <StatCard
          title="Marketing Opt-in"
          value={stats.marketingOptIn}
          hint={`${pct(stats.marketingOptIn, stats.totalCustomers)}% of customers`}
          icon={BellRing}
          tone="emerald"
          delay={0.05}
        />
        <StatCard title="Opted Out" value={stats.optedOut} icon={Ban} tone="rose" delay={0.1} />
        <StatCard
          title="Total Visits"
          value={stats.totalVisits}
          icon={CalendarCheck}
          tone="amber"
          delay={0.15}
        />
        <StatCard
          title="Unique Guests"
          value={stats.uniqueVisitors}
          icon={UserCheck}
          tone="violet"
          delay={0.2}
        />
        <StatCard
          title="Repeat Customers"
          value={stats.repeatCustomers}
          hint={`${stats.repeatRate}% repeat rate`}
          icon={Repeat}
          tone="emerald"
          delay={0.25}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <TrendingUp className="h-4 w-4 text-primary" /> Visits — last 14 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {trendChartData.every((d) => d.visits === 0) && trendChartData.length > 0 ? (
              <div className="flex flex-col items-center justify-center h-[220px] text-center">
                <p className="text-sm text-muted-foreground">
                  No visits recorded in the last 14 days.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => setView("visits")}
                >
                  Record a visit
                </Button>
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[220px] w-full">
                <AreaChart data={trendChartData} margin={{ left: -18, right: 8, top: 6 }}>
                  <defs>
                    <linearGradient id="fillVisits" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-visits)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--color-visits)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    width={34}
                  />
                  <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                  <Area
                    dataKey="visits"
                    type="monotone"
                    stroke="var(--color-visits)"
                    strokeWidth={2.5}
                    fill="url(#fillVisits)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <PieIcon className="h-4 w-4 text-primary" /> Marketing consent
            </CardTitle>
          </CardHeader>
          <CardContent>
            {consentData.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[220px] text-center">
                <p className="text-sm text-muted-foreground">No customers yet.</p>
              </div>
            ) : (
              <div className="relative h-[220px]">
                <ChartContainer config={consentConfig} className="h-[220px] w-full">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                    <Pie
                      data={consentData}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={56}
                      outerRadius={84}
                      paddingAngle={3}
                      strokeWidth={2}
                    >
                      {consentData.map((entry) => (
                        <Cell
                          key={entry.key}
                          fill={`var(--color-${entry.key})`}
                          stroke="var(--background)"
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="text-2xl font-bold tabular-nums leading-none">
                    {pct(stats.marketingOptIn, stats.totalCustomers)}%
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">opted in</p>
                </div>
              </div>
            )}
            <div className="mt-2 space-y-2">
              {consentData.map((d) => (
                <div key={d.key} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: `var(--color-${d.key})` }}
                  />
                  <span className="flex-1 text-muted-foreground">{d.label}</span>
                  <span className="font-semibold tabular-nums">{formatNumber(d.value)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activity.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={CalendarCheck}
                title="No activity yet"
                description="Add your first customer or record a visit — it will show up here instantly."
                action={
                  <Button size="sm" onClick={() => setView("customers")}>
                    <UserPlus className="h-4 w-4" /> Add customer
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y">
              {activity.map((a, i) => (
                <li key={`${a.kind}-${a.id}-${i}`}>
                  <button
                    type="button"
                    onClick={() => onOpenCustomer(a.id)}
                    className="w-full flex items-center gap-3.5 px-6 py-3.5 hover:bg-accent/40 transition-colors text-left"
                  >
                    <div
                      className={
                        a.kind === "visit"
                          ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-600"
                          : "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600"
                      }
                    >
                      {a.kind === "visit" ? (
                        <CalendarCheck className="h-4 w-4" />
                      ) : (
                        <UserPlus className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">
                        {a.name}
                        <span className="ml-2 font-normal text-muted-foreground">{a.detail}</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{formatRelative(a.at)}</p>
                    </div>
                    {a.kind === "customer" && (
                      <Badge variant="secondary" className="hidden sm:inline-flex text-[10.5px]">
                        Customer
                      </Badge>
                    )}
                    <ArrowRight className="h-4 w-4 text-muted-foreground/50" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}
