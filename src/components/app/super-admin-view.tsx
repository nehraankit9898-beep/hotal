"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  SuperAdminHotelsResponse,
  PlatformStats,
  UsageSummary,
  SystemHealthCheck,
  SupportSessionRow,
  FeatureFlagRow,
  PlatformAuditLogsResponse,
} from "@/lib/types";
import { ApiError } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SectionHeading, EmptyState, StatCard } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatCurrency, formatNumber, AUDIT_LABELS } from "@/lib/format";
import {
  Building2,
  Plus,
  Pause,
  Play,
  Activity,
  Shield,
  Loader2,
  KeyRound,
  Globe,
  Wrench,
  Users,
  Send,
  IndianRupee,
  ScrollText,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export function SuperAdminView({ initialTab = "overview" }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Super Admin Control Center"
        description="Multi-tenant platform management: create hotels, change plans, toggle features, monitor usage, audit support sessions."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Create Hotel
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2 md:grid-cols-5 h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="hotels">Hotels</TabsTrigger>
          <TabsTrigger value="health">System Health</TabsTrigger>
          <TabsTrigger value="support">Support</TabsTrigger>
          <TabsTrigger value="audit">Audit Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="hotels" className="mt-6">
          <HotelsTab />
        </TabsContent>
        <TabsContent value="health" className="mt-6">
          <HealthTab />
        </TabsContent>
        <TabsContent value="support" className="mt-6">
          <SupportTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-6">
          <AuditTab />
        </TabsContent>
      </Tabs>

      <CreateHotelDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}

function OverviewTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["super-admin-stats"],
    queryFn: () =>
      api.get<{
        stats: PlatformStats;
        hotels: {
          id: string;
          name: string;
          city: string | null;
          plan: string | null;
          customers: number;
          staff: number;
          campaigns: number;
          status: string;
          createdAt: string;
          lastActivity: string;
        }[];
      }>("/api/super-admin/stats"),
  });
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const stats = data?.stats;
  if (!stats)
    return (
      <EmptyState
        icon={Building2}
        title="No platform data"
        description="Add hotels and seed customers to see platform-wide KPIs."
      />
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Hotels" value={stats.totalHotels} icon={Building2} tone="default" />
        <StatCard
          title="Active Hotels"
          value={stats.activeHotels}
          icon={Building2}
          tone="emerald"
        />
        <StatCard title="Suspended" value={stats.suspendedHotels} icon={Pause} tone="rose" />
        <StatCard
          title="Total Customers"
          value={stats.totalCustomers}
          icon={Users}
          tone="violet"
          delay={0.1}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Restaurant Customers"
          value={stats.restaurantCustomers}
          icon={Users}
          tone="amber"
          delay={0.15}
        />
        <StatCard
          title="Messages Sent"
          value={stats.messagesSent}
          icon={Send}
          tone="default"
          delay={0.2}
        />
        <StatCard
          title="Active Campaigns"
          value={stats.activeCampaigns}
          icon={Activity}
          tone="emerald"
          delay={0.25}
        />
        <StatCard
          title="Monthly Revenue (MRR)"
          value={formatCurrency(stats.monthlyRevenue)}
          icon={IndianRupee}
          tone="amber"
          delay={0.3}
        />
      </div>
      {/* Phase 10 — SaaS business KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="ARR"
          value={formatCurrency(stats.arr ?? 0)}
          icon={IndianRupee}
          tone="emerald"
        />
        <StatCard
          title="Lifetime Collected"
          value={formatCurrency(stats.lifetimeCollected ?? 0)}
          icon={IndianRupee}
          tone="default"
          delay={0.05}
        />
        <StatCard
          title="Trials Running"
          value={stats.trialingSubscriptions ?? 0}
          icon={KeyRound}
          tone="violet"
          delay={0.1}
        />
        <StatCard
          title="Active Subscriptions"
          value={stats.activeSubscriptions ?? 0}
          icon={Shield}
          tone="emerald"
          delay={0.15}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Trial Conversion"
          value={`${stats.trialConversionRate ?? 0}%`}
          icon={Globe}
          tone="amber"
        />
        <StatCard
          title="Churn"
          value={`${stats.churnRate ?? 0}%`}
          icon={Pause}
          tone="rose"
          delay={0.05}
        />
        <StatCard
          title="Grace / Expired / Cancelled"
          value={`${stats.graceSubscriptions ?? 0} / ${stats.expiredSubscriptions ?? 0} / ${stats.cancelledSubscriptions ?? 0}`}
          icon={Wrench}
          tone="default"
          delay={0.1}
        />
        <StatCard
          title="Active Hotel Admins"
          value={stats.activeHotelAdmins ?? 0}
          icon={Users}
          tone="violet"
          delay={0.15}
        />
      </div>
      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">Recent Hotels</h3>
          {(data?.hotels ?? []).slice(0, 5).map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between py-2 border-b last:border-0"
            >
              <div>
                <p className="font-medium text-sm">{h.name}</p>
                <p className="text-xs text-muted-foreground">
                  {h.plan} · {h.city ?? "—"}
                </p>
              </div>
              <Badge
                variant="outline"
                className={
                  h.status === "ACTIVE"
                    ? "bg-emerald-500/15 text-emerald-600"
                    : "bg-rose-500/15 text-rose-600"
                }
              >
                {h.status}
              </Badge>
            </div>
          ))}
          {(data?.hotels ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No hotels yet — create your first one.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HotelsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedHotelId, setSelectedHotelId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["super-admin-hotels"],
    queryFn: () => api.get<SuperAdminHotelsResponse>("/api/super-admin/hotels"),
  });

  const suspendMutation = useMutation({
    mutationFn: ({ hotelId, reason }: { hotelId: string; reason: string }) =>
      api.post(`/api/super-admin/hotels/suspend?id=${hotelId}`, { reason }),
    onSuccess: () => {
      toast({ title: "Hotel suspended", description: "The hotel is now in suspended status." });
      qc.invalidateQueries({ queryKey: ["super-admin-hotels"] });
    },
  });
  const activateMutation = useMutation({
    mutationFn: (hotelId: string) => api.post(`/api/super-admin/hotels/activate?id=${hotelId}`),
    onSuccess: () => {
      toast({ title: "Hotel activated" });
      qc.invalidateQueries({ queryKey: ["super-admin-hotels"] });
    },
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  const hotels = data?.hotels ?? [];
  const plans = data?.plans ?? [];

  if (selectedHotelId) {
    return (
      <HotelDetailPanel
        hotelId={selectedHotelId}
        onBack={() => setSelectedHotelId(null)}
        plans={plans}
      />
    );
  }

  if (hotels.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No hotels yet"
        description="Create your first hotel tenant to start onboarding customers."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hotel</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Customers</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hotels.map((h) => (
              <TableRow key={h.id}>
                <TableCell>
                  <button onClick={() => setSelectedHotelId(h.id)} className="text-left">
                    <div className="font-medium hover:underline">{h.name}</div>
                    <div className="text-xs text-muted-foreground">{h.email ?? h.phone ?? "—"}</div>
                  </button>
                </TableCell>
                <TableCell className="text-sm">{h.owner?.name ?? "—"}</TableCell>
                <TableCell className="text-sm">{h.city ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{h.plan?.name ?? "FREE"}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{formatNumber(h.counts.customers)}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      h.status === "ACTIVE"
                        ? "bg-emerald-500/15 text-emerald-600"
                        : "bg-rose-500/15 text-rose-600"
                    }
                  >
                    {h.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex gap-2 justify-end">
                    {h.status === "ACTIVE" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          suspendMutation.mutate({
                            hotelId: h.id,
                            reason: "Manually suspended by super admin",
                          })
                        }
                        disabled={suspendMutation.isPending}
                      >
                        <Pause className="h-3.5 w-3.5 mr-1" /> Suspend
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => activateMutation.mutate(h.id)}
                        disabled={activateMutation.isPending}
                      >
                        <Play className="h-3.5 w-3.5 mr-1" /> Activate
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function HotelDetailPanel({
  hotelId,
  onBack,
  plans,
}: {
  hotelId: string;
  onBack: () => void;
  plans: SuperAdminHotelsResponse["plans"];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: usage } = useQuery({
    queryKey: ["super-admin-usage", hotelId],
    queryFn: () => api.get<{ usage: UsageSummary }>(`/api/super-admin/usage?id=${hotelId}`),
  });
  const { data: featuresData } = useQuery({
    queryKey: ["super-admin-features", hotelId],
    queryFn: () =>
      api.get<{ features: FeatureFlagRow[]; availableKeys: string[] }>(
        `/api/super-admin/features?id=${hotelId}`,
      ),
  });

  const toggleFeature = useMutation({
    mutationFn: ({ featureKey, enabled }: { featureKey: string; enabled: boolean }) =>
      api.put(`/api/super-admin/features?id=${hotelId}`, { featureKey, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["super-admin-features", hotelId] }),
  });

  const requestSupport = useMutation({
    mutationFn: ({ reason, durationMinutes }: { reason: string; durationMinutes: number }) =>
      api.post(`/api/super-admin/support?id=${hotelId}`, { reason, durationMinutes }),
    onSuccess: () => {
      toast({
        title: "Support access granted",
        description: "You now have temporary access to this hotel's data.",
      });
      qc.invalidateQueries({ queryKey: ["super-admin-support"] });
    },
  });

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back to hotels
      </Button>
      <SectionHeading title="Hotel Details" description={`Tenant ID: ${hotelId}`} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">Usage vs Plan Limits</h3>
            {!usage ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="space-y-3">
                <UsageBar
                  label="Customers"
                  used={usage.usage.customersUsed}
                  limit={usage.usage.customersLimit}
                  percent={usage.usage.customersPercent}
                />
                <UsageBar
                  label="Messages"
                  used={usage.usage.messagesUsed}
                  limit={usage.usage.messagesLimit}
                  percent={usage.usage.messagesPercent}
                />
                <UsageBar
                  label="Campaigns"
                  used={usage.usage.campaignsUsed}
                  limit={usage.usage.campaignsLimit}
                  percent={usage.usage.campaignsPercent}
                />
                <UsageBar
                  label="Staff"
                  used={usage.usage.staffUsed}
                  limit={usage.usage.staffLimit}
                  percent={usage.usage.staffPercent}
                />
                <UsageBar
                  label="Storage (MB)"
                  used={Math.round(usage.usage.storageMb)}
                  limit={usage.usage.storageMbLimit}
                  percent={usage.usage.storagePercent}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">Feature Flags</h3>
            {!featuresData ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="space-y-2">
                {featuresData.features.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between py-1.5 border-b last:border-0"
                  >
                    <div>
                      <span className="text-sm font-medium">
                        {f.featureKey
                          .replace(/_/g, " ")
                          .toLowerCase()
                          .replace(/\b\w/g, (c) => c.toUpperCase())}
                      </span>
                    </div>
                    <Switch
                      checked={f.enabled}
                      onCheckedChange={(checked) =>
                        toggleFeature.mutate({ featureKey: f.featureKey, enabled: checked })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3">Request Support Access</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Time-limited access to this hotel's data. The hotel owner is notified. Access
            auto-expires when the timer ends.
          </p>
          <RequestSupportForm
            onSubmit={(body) => requestSupport.mutate(body)}
            loading={requestSupport.isPending}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function UsageBar({
  label,
  used,
  limit,
  percent,
}: {
  label: string;
  used: number;
  limit: number;
  percent: number;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatNumber(used)} / {limit > 0 ? formatNumber(limit) : "∞"}
        </span>
      </div>
      <Progress
        value={percent}
        className={`h-2 ${percent >= 90 ? "bg-rose-500/20" : percent >= 70 ? "bg-amber-500/20" : ""}`}
      />
    </div>
  );
}

function RequestSupportForm({
  onSubmit,
  loading,
}: {
  onSubmit: (body: { reason: string; durationMinutes: number }) => void;
  loading: boolean;
}) {
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  return (
    <div className="flex flex-wrap gap-2 items-end">
      <div className="flex-1 min-w-[200px]">
        <Label className="text-xs">Reason</Label>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Debugging WhatsApp campaign failure"
        />
      </div>
      <div className="w-[120px]">
        <Label className="text-xs">Minutes</Label>
        <Input
          type="number"
          value={durationMinutes}
          onChange={(e) => setDurationMinutes(e.target.value)}
          min={5}
          max={480}
        />
      </div>
      <Button
        size="sm"
        disabled={loading || !reason}
        onClick={() => onSubmit({ reason, durationMinutes: Number(durationMinutes) })}
      >
        {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
        <KeyRound className="h-4 w-4 mr-1.5" /> Request
      </Button>
    </div>
  );
}

function HealthTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["super-admin-health"],
    queryFn: () =>
      api.get<{ checks: SystemHealthCheck[]; timestamp: string }>("/api/super-admin/health"),
  });
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const checks = data?.checks ?? [];
  const statusTone = (s: string) =>
    s === "HEALTHY"
      ? "bg-emerald-500/15 text-emerald-600"
      : s === "DEGRADED"
        ? "bg-amber-500/15 text-amber-600"
        : "bg-rose-500/15 text-rose-600";

  return (
    <Card>
      <CardContent className="p-0">
        <div className="p-4 border-b">
          <h3 className="text-sm font-semibold">Subsystem Health</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last checked: {data?.timestamp ? formatDateTime(data.timestamp) : "—"}
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subsystem</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c) => (
              <TableRow key={c.subsystem}>
                <TableCell className="font-medium">{c.subsystem}</TableCell>
                <TableCell>
                  <Badge className={statusTone(c.status)}>{c.status}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{c.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SupportTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["super-admin-support"],
    queryFn: () => api.get<{ sessions: SupportSessionRow[] }>("/api/super-admin/support"),
  });
  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const sessions = data?.sessions ?? [];
  if (sessions.length === 0)
    return (
      <EmptyState
        icon={KeyRound}
        title="No support sessions"
        description="When you request support access to a hotel, the session appears here with its expiry timer."
      />
    );
  const statusTone = (s: string) =>
    s === "ACTIVE"
      ? "bg-emerald-500/15 text-emerald-600"
      : s === "EXPIRED"
        ? "bg-slate-500/15 text-slate-600"
        : s === "ENDED"
          ? "bg-slate-500/15 text-slate-600"
          : "bg-amber-500/15 text-amber-600";

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hotel</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.hotel.name ?? "—"}</TableCell>
                <TableCell className="text-sm">{s.reason}</TableCell>
                <TableCell className="tabular-nums">{s.durationMinutes} min</TableCell>
                <TableCell className="text-xs">{formatDateTime(s.startedAt)}</TableCell>
                <TableCell className="text-xs">{formatDateTime(s.expiresAt)}</TableCell>
                <TableCell>
                  <Badge className={statusTone(s.status)}>{s.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AuditTab() {
  // Phase 8.1 §5 — REAL cross-tenant platform audit trail (was a static card).
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["super-admin-audit", { action, page }],
    queryFn: () =>
      api.get<PlatformAuditLogsResponse>(
        `/api/super-admin/audit?action=${encodeURIComponent(action)}&page=${page}&pageSize=15`,
      ),
    placeholderData: keepPreviousData,
  });

  const logs = data?.logs ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Cross-Tenant Audit Trail</h3>
            <p className="text-xs text-muted-foreground">
              Every sensitive action across all hotels — actor, hotel, action, timestamp.
            </p>
          </div>
          <Select
            value={action}
            onValueChange={(v) => {
              setAction(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Filter by action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {(data?.actions ?? []).map((a) => (
                <SelectItem key={a} value={a}>
                  {AUDIT_LABELS[a] ?? a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : isError ? (
          <EmptyState
            icon={ScrollText}
            title="Could not load audit logs"
            description="Platform audit could not be loaded. Try again."
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            }
          />
        ) : logs.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit entries"
            description="Platform and hotel actions will appear here as they happen."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Hotel</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Entity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(l.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.hotel?.name ?? <span className="text-muted-foreground">Platform</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="max-w-[220px] truncate">
                        {AUDIT_LABELS[l.action] ?? l.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.user ? (
                        <div>
                          <div className="font-medium">{l.user.name}</div>
                          <div className="text-muted-foreground">{l.user.role}</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">System</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {l.entityType ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Page {page} of {totalPages} · {formatNumber(data?.total ?? 0)} entries
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CreateHotelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("India");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [planName, setPlanName] = useState("STARTER");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [invitationLink, setInvitationLink] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["super-admin-plans-list"],
    queryFn: () => api.get<{ plans: SuperAdminHotelsResponse["plans"] }>("/api/super-admin/hotels"),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      address: string | null;
      city: string | null;
      state: string | null;
      country: string | null;
      phone: string | null;
      email: string | null;
      planName: string;
      ownerName: string;
      ownerEmail: string;
    }) =>
      api.post<{
        hotel: { name: string };
        owner: { email: string };
        invitation?: { activationUrl: string | null } | null;
      }>("/api/super-admin/hotels", body),
    onSuccess: (res) => {
      toast({
        title: "Hotel tenant created",
        description: `${res.hotel.name} created. Owner: ${res.owner.email}. Share the one-time invitation link with the owner — they will choose their own password (valid 72h).`,
      });
      setInvitationLink(res.invitation?.activationUrl ?? null);
      qc.invalidateQueries({ queryKey: ["super-admin-hotels"] });
      qc.invalidateQueries({ queryKey: ["super-admin-stats"] });
      onOpenChange(false);
      setName("");
      setOwnerName("");
      setOwnerEmail("");
      setInvitationLink(null);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not create hotel",
        description: err instanceof ApiError ? err.message : "Could not create hotel.",
        variant: "destructive",
      }),
  });

  function submit() {
    createMutation.mutate({
      name,
      address,
      city,
      state,
      country,
      phone,
      email,
      planName,
      ownerName,
      ownerEmail,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Hotel Tenant</DialogTitle>
          <DialogDescription>
            A new hotel with its own owner account, plan, subscription, and feature flags.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Hotel Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The Grand Palace"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Mumbai" />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Input
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="Maharashtra"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91..."
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="info@grandpalace.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planName} onValueChange={setPlanName}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(data?.plans ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.name}>
                    {p.name} — ₹{p.monthlyPrice}/mo
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="border-t pt-3 mt-3">
            <h4 className="text-sm font-semibold mb-3">Owner Account</h4>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Owner Name</Label>
                  <Input
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="Rajesh Kumar"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Owner Email</Label>
                  <Input
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                    placeholder="rajesh@grandpalace.com"
                  />
                </div>
              </div>
              {invitationLink ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs">
                  <p className="font-medium text-emerald-900 mb-1">
                    One-time owner invitation link (expires in 72h):
                  </p>
                  <code className="break-all text-emerald-800">{invitationLink}</code>
                  <p className="text-emerald-700 mt-1">
                    Copy it now - it will not be shown again. The owner chooses their own password
                    on first sign-in.
                  </p>
                </div>
              ) : (
                <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  The owner receives a one-time invitation link and chooses their own password on
                  first sign-in. No default passwords are issued.
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createMutation.isPending || !name || !ownerEmail}>
            {createMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Create
            Hotel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
