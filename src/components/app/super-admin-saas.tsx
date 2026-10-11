"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type {
  PublicPlan,
  SubscriptionRow,
  BillingCouponRow,
  GlobalFlagRow,
  PaymentRow,
  SecurityEventRow,
  BackupHistoryRow,
  NotificationTemplateRow,
  UsageSummaryRow,
} from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SectionHeading, EmptyState, StatCard } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatCurrency, formatNumber } from "@/lib/format";
import {
  IndianRupee,
  Plus,
  Loader2,
  Pencil,
  Archive,
  RefreshCw,
  Search,
  Ticket,
  Flag,
  CreditCard,
  Shield,
  DatabaseBackup,
  MessageSquareText,
  Settings2,
  Ban,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  KeyRound,
  FileText,
  Send,
  Save,
  X,
  BarChart3,
} from "lucide-react";

/**
 * Phase 10 — Super Admin SaaS console tabs.
 *
 * Every control here writes through to a server API that changes ACTUAL
 * application behaviour (guards in src/lib/saas/*): pricing → /api/pricing,
 * trials → tenant state machine, limits → creation guards, flags →
 * entitlement resolution. No fake switches.
 */

const queryClientKeys = {
  plans: "sa-plans",
  subscriptions: "sa-subscriptions",
  coupons: "sa-coupons",
  flags: "sa-flags",
  billing: "sa-billing",
  security: "sa-security",
  backups: "sa-backups",
  templates: "sa-templates",
  settings: "sa-settings",
  usage: "sa-usage",
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    {
      variant: "default" | "secondary" | "destructive" | "outline";
      className?: string;
      label: string;
    }
  > = {
    ACTIVE: {
      variant: "default",
      className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      label: "ACTIVE",
    },
    TRIALING: {
      variant: "default",
      className: "bg-sky-500/15 text-sky-600 border-sky-500/30",
      label: "TRIAL",
    },
    GRACE: {
      variant: "default",
      className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
      label: "GRACE",
    },
    PAST_DUE: {
      variant: "default",
      className: "bg-orange-500/15 text-orange-600 border-orange-500/30",
      label: "PAST DUE",
    },
    PAUSED: { variant: "secondary", label: "PAUSED" },
    CANCELLED: { variant: "secondary", label: "CANCELLED" },
    EXPIRED: { variant: "destructive", label: "EXPIRED" },
    SUSPENDED: { variant: "destructive", label: "SUSPENDED" },
    PAID: {
      variant: "default",
      className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      label: "PAID",
    },
    PENDING: {
      variant: "default",
      className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
      label: "PENDING",
    },
    FAILED: { variant: "destructive", label: "FAILED" },
    REFUNDED: { variant: "secondary", label: "REFUNDED" },
    PARTIALLY_REFUNDED: { variant: "outline", label: "PART-REFUNDED" },
    SUCCESS: {
      variant: "default",
      className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      label: "SUCCESS",
    },
    RUNNING: {
      variant: "default",
      className: "bg-sky-500/15 text-sky-600 border-sky-500/30",
      label: "RUNNING",
    },
  };
  const conf = map[status] ?? { variant: "outline" as const, label: status };
  return (
    <Badge variant={conf.variant} className={conf.className}>
      {conf.label}
    </Badge>
  );
}

function useApiError() {
  const { toast } = useToast();
  return (err: unknown, fallback: string) => {
    const message = err instanceof ApiError ? err.message : fallback;
    toast({ title: "Something went wrong", description: message, variant: "destructive" });
  };
}

// ============================================================
// PLANS & PRICING
// ============================================================

const FEATURE_KEYS = [
  "ROOM_CRM",
  "RESTAURANT_CRM",
  "CUSTOMER_CRM",
  "CAMPAIGNS",
  "WHATSAPP",
  "SMS",
  "EMAIL",
  "OFFERS",
  "AUTOMATION",
  "ANALYTICS",
  "AI_ASSISTANT",
  "REPORTS",
  "API",
  "POS_INTEGRATION",
  "ADVANCED_ANALYTICS",
  "LOYALTY",
  "QR",
];

interface PlanFormState {
  name: string;
  key: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  setupFee: number;
  trialDays: number;
  graceDays: number;
  isPublic: boolean;
  recommended: boolean;
  sortOrder: number;
  features: string[];
  customerLimit: number;
  campaignLimit: number;
  messageLimit: number;
  staffLimit: number;
  aiUsageLimit: number;
  storageMb: number;
  apiRequestLimit: number;
  exportsLimit: number;
}

const EMPTY_PLAN: PlanFormState = {
  name: "",
  key: "",
  description: "",
  monthlyPrice: 0,
  yearlyPrice: 0,
  currency: "INR",
  setupFee: 0,
  trialDays: 14,
  graceDays: 7,
  isPublic: true,
  recommended: false,
  sortOrder: 0,
  features: ["ROOM_CRM", "CUSTOMER_CRM", "CAMPAIGNS", "ANALYTICS", "REPORTS"],
  customerLimit: 500,
  campaignLimit: 10,
  messageLimit: 2000,
  staffLimit: 5,
  aiUsageLimit: 100,
  storageMb: 1024,
  apiRequestLimit: 10000,
  exportsLimit: 50,
};

export function SaasPlansTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.plans],
    queryFn: () => api.get<{ plans: PublicPlan[] }>("/api/super-admin/plans"),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ open: boolean; plan: PublicPlan | null }>({
    open: false,
    plan: null,
  });
  const [form, setForm] = useState<PlanFormState>(EMPTY_PLAN);

  function openCreate() {
    setForm(EMPTY_PLAN);
    setDialog({ open: true, plan: null });
  }
  function openEdit(plan: PublicPlan) {
    setForm({
      name: plan.name,
      key: plan.key,
      description: plan.description ?? "",
      monthlyPrice: plan.monthlyPrice,
      yearlyPrice: plan.yearlyPrice,
      currency: plan.currency,
      setupFee: plan.setupFee,
      trialDays: plan.trialDays,
      graceDays: plan.graceDays,
      isPublic: plan.isPublic ?? true,
      recommended: plan.recommended,
      sortOrder: plan.sortOrder,
      features: plan.features,
      customerLimit: plan.limits.customers,
      campaignLimit: plan.limits.campaigns,
      messageLimit: plan.limits.messages,
      staffLimit: plan.limits.staff,
      aiUsageLimit: plan.limits.aiRequests,
      storageMb: plan.limits.storageMb,
      apiRequestLimit: plan.limits.apiRequests,
      exportsLimit: plan.limits.exports,
    });
    setDialog({ open: true, plan });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (dialog.plan) {
        return api.put(`/api/super-admin/plans/${dialog.plan.id}`, form);
      }
      return api.post("/api/super-admin/plans", form);
    },
    onSuccess: () => {
      toast({
        title: dialog.plan ? "Plan updated" : "Plan created",
        description: "Pricing changes are live immediately — the frontend reads them from the API.",
      });
      setDialog({ open: false, plan: null });
      queryClient.invalidateQueries({ queryKey: [queryClientKeys.plans] });
    },
    onError: (err) => onError(err, "Could not save the plan."),
  });

  const archive = useMutation({
    mutationFn: (plan: PublicPlan) =>
      api.delete<{ archived?: boolean; deleted?: boolean }>(`/api/super-admin/plans/${plan.id}`),
    onSuccess: (res) => {
      toast({
        title: res.archived ? "Plan archived" : "Plan deleted",
        description: res.archived
          ? "Active subscriptions keep running; the plan is no longer purchasable."
          : "No dependencies — plan removed.",
      });
      queryClient.invalidateQueries({ queryKey: [queryClientKeys.plans] });
    },
    onError: (err) => onError(err, "Could not archive the plan."),
  });

  const confirmArchive = useMutation({
    mutationFn: async (plan: PublicPlan) => {
      const reason = window.prompt(
        `Archive plan "${plan.name}"? Active subscriptions keep running but the plan stops being purchasable.\n\nReason:`,
      );
      if (reason === null) throw new Error("cancelled");
      void reason;
      return plan;
    },
    onError: () => undefined,
    onSuccess: (plan) => archive.mutate(plan),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const plans = data?.plans ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Plans & Pricing"
        description="Create unlimited plans. Prices live in the database — never hardcoded in the frontend."
        action={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> Create Plan
          </Button>
        }
      />
      {plans.length === 0 ? (
        <EmptyState
          icon={IndianRupee}
          title="No plans yet"
          description="Create your first plan to start selling StayLoop."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <Card key={plan.id} className={plan.isArchived ? "opacity-60" : ""}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {plan.name}
                      {plan.recommended && (
                        <Badge className="bg-primary/15 text-primary border-primary/30">
                          Recommended
                        </Badge>
                      )}
                      {plan.isArchived && <Badge variant="secondary">Archived</Badge>}
                      {!plan.isPublic && <Badge variant="outline">Private</Badge>}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {plan.description}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold">
                      {formatCurrency(plan.monthlyPrice)}
                      <span className="text-xs font-normal text-muted-foreground">/mo</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatCurrency(plan.yearlyPrice)}/yr
                    </p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {plan.features.slice(0, 6).map((f) => (
                    <Badge key={f} variant="outline" className="text-[10px]">
                      {f.replace(/_/g, " ")}
                    </Badge>
                  ))}
                  {plan.features.length > 6 && (
                    <Badge variant="outline" className="text-[10px]">
                      +{plan.features.length - 6}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    Customers: <b className="text-foreground">{plan.limits.customers || "∞"}</b>
                  </span>
                  <span>
                    Messages:{" "}
                    <b className="text-foreground">{formatNumber(plan.limits.messages) || "∞"}</b>
                  </span>
                  <span>
                    Staff: <b className="text-foreground">{plan.limits.staff || "∞"}</b>
                  </span>
                  <span>
                    Trial: <b className="text-foreground">{plan.trialDays}d</b>
                  </span>
                  <span>
                    Hotels: <b className="text-foreground">{plan.usage?.hotels ?? 0}</b>
                  </span>
                  <span>
                    API: <b className="text-foreground">{plan.limits.apiAccess ? "Yes" : "No"}</b>
                  </span>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => openEdit(plan)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => confirmArchive.mutate(plan)}
                    disabled={plan.isArchived}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" /> Archive
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PlanDialog
        open={dialog.open}
        plan={dialog.plan}
        form={form}
        setForm={setForm}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onCancel={() => setDialog({ open: false, plan: null })}
      />
    </div>
  );
}

function PlanDialog({
  open,
  plan,
  form,
  setForm,
  saving,
  onSave,
  onCancel,
}: {
  open: boolean;
  plan: PublicPlan | null;
  form: PlanFormState;
  setForm: (f: PlanFormState) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof PlanFormState>(key: K, value: PlanFormState[K]) =>
    setForm({ ...form, [key]: value });
  const numberField = (key: keyof PlanFormState, label: string) => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={0}
        value={String(form[key])}
        onChange={(e) => set(key, (Number(e.target.value) || 0) as never)}
        className="h-9"
      />
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plan ? `Edit plan — ${plan.name}` : "Create a new plan"}</DialogTitle>
          <DialogDescription>
            Prices are stored in the database and served through /api/pricing. Limits of 0 mean
            unlimited.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Plan name</Label>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className="h-9"
                placeholder="Growth"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Internal key</Label>
              <Input
                value={form.key}
                onChange={(e) =>
                  set("key", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
                }
                className="h-9"
                placeholder="growth"
                disabled={Boolean(plan)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {numberField("monthlyPrice", "Monthly price")}
            {numberField("yearlyPrice", "Yearly price")}
            {numberField("setupFee", "Setup fee")}
          </div>
          <div className="grid grid-cols-4 gap-3">
            {numberField("trialDays", "Trial days")}
            {numberField("graceDays", "Grace days")}
            <div className="space-y-1.5">
              <Label className="text-xs">Currency</Label>
              <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {numberField("sortOrder", "Sort order")}
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Plan features (entitlement gate)</Label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 rounded-lg border p-3 max-h-40 overflow-y-auto">
              {FEATURE_KEYS.map((feature) => (
                <label key={feature} className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <Checkbox
                    checked={form.features.includes(feature)}
                    onCheckedChange={(checked) => {
                      const features = checked
                        ? [...form.features, feature]
                        : form.features.filter((f) => f !== feature);
                      set("features", features);
                    }}
                  />
                  {feature.replace(/_/g, " ")}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {numberField("customerLimit", "Customers limit")}
            {numberField("campaignLimit", "Campaigns limit")}
            {numberField("messageLimit", "Messages limit")}
            {numberField("staffLimit", "Staff limit")}
            {numberField("aiUsageLimit", "AI requests limit")}
            {numberField("storageMb", "Storage (MB)")}
            {numberField("apiRequestLimit", "API requests limit")}
            {numberField("exportsLimit", "Exports limit")}
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.isPublic} onCheckedChange={(v) => set("isPublic", v)} />
              Public pricing page
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.recommended} onCheckedChange={(v) => set("recommended", v)} />
              Recommended
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <Save className="h-4 w-4 mr-1.5" />
            )}
            {plan ? "Save changes" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// SUBSCRIPTIONS & TRIALS
// ============================================================

export function SaasSubscriptionsTab() {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.subscriptions, status, q, page],
    queryFn: () =>
      api.get<{ subscriptions: SubscriptionRow[]; total: number; totalPages: number }>(
        `/api/super-admin/subscriptions?status=${status === "all" ? "" : status}&q=${encodeURIComponent(q)}&page=${page}`,
      ),
    placeholderData: keepPreviousData,
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [actionDialog, setActionDialog] = useState<{
    open: boolean;
    sub: SubscriptionRow | null;
    action: string;
    title: string;
    needsPlan?: boolean;
    needsDays?: boolean;
  }>({ open: false, sub: null, action: "", title: "" });
  const [reason, setReason] = useState("");
  const [planId, setPlanId] = useState("");
  const [days, setDays] = useState(7);

  const { data: plansData } = useQuery({
    queryKey: [queryClientKeys.plans],
    queryFn: () => api.get<{ plans: PublicPlan[] }>("/api/super-admin/plans"),
  });

  const runAction = useMutation({
    mutationFn: (params: {
      subscriptionId: string;
      action: string;
      reason: string;
      planId?: string;
      days?: number;
    }) => api.post("/api/super-admin/subscriptions/action", params),
    onSuccess: () => {
      toast({
        title: "Subscription updated",
        description: "The change is effective immediately and audited.",
      });
      setActionDialog({ open: false, sub: null, action: "", title: "" });
      setReason("");
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.subscriptions] });
    },
    onError: (err) => onError(err, "Could not perform the action."),
  });

  const subs = data?.subscriptions ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Subscriptions & Trials"
        description="Full tenant lifecycle: trials, grace, renewals, plan changes, suspension. Every action needs a reason and creates an audit entry."
      />
      <div className="flex flex-wrap gap-2 items-center">
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[170px] h-9">
            <Search className="h-3.5 w-3.5 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              "all",
              "TRIALING",
              "ACTIVE",
              "GRACE",
              "PAST_DUE",
              "PAUSED",
              "CANCELLED",
              "EXPIRED",
              "SUSPENDED",
            ].map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All statuses" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Search hotel…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="w-56 h-9"
        />
        <Badge variant="outline" className="ml-auto">
          {data?.total ?? 0} subscriptions
        </Badge>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : subs.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          title="No subscriptions"
          description="Create hotels or change filters to see subscriptions here."
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hotel</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trial ends</TableHead>
                  <TableHead>Period / Renewal</TableHead>
                  <TableHead>MRR</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subs.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <p className="font-medium text-sm">{sub.hotelName}</p>
                      <p className="text-[11px] text-muted-foreground">{sub.tenantId}</p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{sub.plan?.name ?? "—"}</p>
                      <p className="text-[11px] text-muted-foreground">{sub.billingCycle}</p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={sub.status} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {sub.trialEndsAt ? formatDateTime(sub.trialEndsAt) : "—"}
                      {sub.graceEndsAt && (
                        <p className="text-[10px] text-muted-foreground">
                          grace: {formatDateTime(sub.graceEndsAt)}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {sub.currentPeriodEnd ? formatDateTime(sub.currentPeriodEnd) : "—"}
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {sub.status === "ACTIVE" ? formatCurrency(sub.amount) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            setActionDialog({
                              open: true,
                              sub,
                              action: "change-plan",
                              title: `Change plan — ${sub.hotelName}`,
                              needsPlan: true,
                            })
                          }
                        >
                          Plan
                        </Button>
                        {sub.status === "TRIALING" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() =>
                                setActionDialog({
                                  open: true,
                                  sub,
                                  action: "extend-trial",
                                  title: `Extend trial — ${sub.hotelName}`,
                                  needsDays: true,
                                })
                              }
                            >
                              + Trial
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() =>
                                setActionDialog({
                                  open: true,
                                  sub,
                                  action: "activate",
                                  title: `Convert to paid — ${sub.hotelName}`,
                                })
                              }
                            >
                              Convert
                            </Button>
                          </>
                        )}
                        {sub.status !== "SUSPENDED" && sub.status !== "CANCELLED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-rose-600"
                            onClick={() =>
                              setActionDialog({
                                open: true,
                                sub,
                                action: "suspend",
                                title: `Suspend subscription — ${sub.hotelName}`,
                              })
                            }
                          >
                            Suspend
                          </Button>
                        )}
                        {(sub.status === "SUSPENDED" ||
                          sub.status === "CANCELLED" ||
                          sub.status === "EXPIRED" ||
                          sub.status === "PAUSED") && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-emerald-600"
                            onClick={() =>
                              setActionDialog({
                                open: true,
                                sub,
                                action: "activate",
                                title: `Reactivate — ${sub.hotelName}`,
                              })
                            }
                          >
                            Reactivate
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
      )}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Dialog
        open={actionDialog.open}
        onOpenChange={(o) =>
          !o && setActionDialog({ open: false, sub: null, action: "", title: "" })
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionDialog.title}</DialogTitle>
            <DialogDescription>
              High-impact operation. A reason is required and the change is audited with your
              account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {actionDialog.needsPlan && (
              <div className="space-y-1.5">
                <Label className="text-xs">New plan</Label>
                <Select value={planId} onValueChange={setPlanId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Choose plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {(plansData?.plans ?? [])
                      .filter((p) => !p.isArchived)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} — {formatCurrency(p.monthlyPrice)}/mo
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {actionDialog.needsDays && (
              <div className="space-y-1.5">
                <Label className="text-xs">Days to extend (negative shortens)</Label>
                <Input
                  type="number"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value) || 0)}
                  className="h-9"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Reason (required)</Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Customer requested extension after onboarding delay"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setActionDialog({ open: false, sub: null, action: "", title: "" })}
            >
              Cancel
            </Button>
            <Button
              variant={actionDialog.action === "suspend" ? "destructive" : "default"}
              disabled={
                runAction.isPending ||
                reason.trim().length < 3 ||
                (actionDialog.needsPlan && !planId)
              }
              onClick={() =>
                actionDialog.sub &&
                runAction.mutate({
                  subscriptionId: actionDialog.sub.id,
                  action: actionDialog.action,
                  reason,
                  planId: actionDialog.needsPlan ? planId : undefined,
                  days: actionDialog.needsDays ? days : undefined,
                })
              }
            >
              {runAction.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// BILLING COUPONS
// ============================================================

export function SaasCouponsTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.coupons],
    queryFn: () => api.get<{ coupons: BillingCouponRow[] }>("/api/super-admin/coupons?all=1"),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    code: "",
    description: "",
    discountType: "PERCENT",
    percentOff: 10,
    amountOff: 500,
    maxDiscountAmount: 5000,
    minAmount: 0,
    usageLimit: 100,
    perTenantLimit: 1,
    expiresAt: "",
    applicablePlans: null as string[] | null,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post("/api/super-admin/coupons", {
        ...form,
        expiresAt: form.expiresAt || null,
      }),
    onSuccess: () => {
      toast({
        title: "Coupon created",
        description: "Valid immediately at checkout with race-condition-safe redemption.",
      });
      setShowCreate(false);
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.coupons] });
    },
    onError: (err) => onError(err, "Could not create the coupon."),
  });

  const toggle = useMutation({
    mutationFn: (coupon: BillingCouponRow) =>
      api.put(`/api/super-admin/coupons/${coupon.id}`, { isActive: !coupon.isActive }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [queryClientKeys.coupons] }),
    onError: (err) => onError(err, "Could not update the coupon."),
  });

  const coupons = data?.coupons ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Billing Coupons"
        description="Checkout discounts with validation: no negative pricing, no expired redemption, atomic usage limits."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Create Coupon
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : coupons.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="No coupons"
          description="Create a discount code for plan checkouts."
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Validity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coupons.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <p className="font-mono text-sm font-semibold">{c.code}</p>
                      {c.description && (
                        <p className="text-[11px] text-muted-foreground">{c.description}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.discountType === "PERCENT"
                        ? `${c.percentOff}%${c.maxDiscountAmount ? ` (max ${formatCurrency(c.maxDiscountAmount)})` : ""}`
                        : formatCurrency(c.amountOff ?? 0)}
                      {c.minAmount ? (
                        <p className="text-[10px] text-muted-foreground">
                          min {formatCurrency(c.minAmount)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.usedCount}
                      {c.usageLimit ? ` / ${c.usageLimit}` : " / ∞"}
                      {c.perTenantLimit ? (
                        <p className="text-[10px] text-muted-foreground">
                          {c.perTenantLimit} per hotel
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.expiresAt ? `until ${formatDateTime(c.expiresAt)}` : "no expiry"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.isActive ? "ACTIVE" : "CANCELLED"} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => toggle.mutate(c)}
                      >
                        {c.isActive ? "Disable" : "Enable"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create billing coupon</DialogTitle>
            <DialogDescription>
              Applies at checkout. Usage limits are enforced atomically against race conditions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Code</Label>
                <Input
                  value={form.code}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""),
                    })
                  }
                  placeholder="EARLY20"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Type</Label>
                <Select
                  value={form.discountType}
                  onValueChange={(v) => setForm({ ...form, discountType: v })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENT">Percentage</SelectItem>
                    <SelectItem value="FIXED">Fixed amount</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.discountType === "PERCENT" ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Percent off (1-100)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={form.percentOff}
                    onChange={(e) => setForm({ ...form, percentOff: Number(e.target.value) || 0 })}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Max discount</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.maxDiscountAmount}
                    onChange={(e) =>
                      setForm({ ...form, maxDiscountAmount: Number(e.target.value) || 0 })
                    }
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Min amount</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.minAmount}
                    onChange={(e) => setForm({ ...form, minAmount: Number(e.target.value) || 0 })}
                    className="h-9"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount off</Label>
                  <Input
                    type="number"
                    min={1}
                    value={form.amountOff}
                    onChange={(e) => setForm({ ...form, amountOff: Number(e.target.value) || 0 })}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Min amount</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.minAmount}
                    onChange={(e) => setForm({ ...form, minAmount: Number(e.target.value) || 0 })}
                    className="h-9"
                  />
                </div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Usage limit (total)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.usageLimit}
                  onChange={(e) => setForm({ ...form, usageLimit: Number(e.target.value) || 0 })}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Per-hotel limit</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.perTenantLimit}
                  onChange={(e) =>
                    setForm({ ...form, perTenantLimit: Number(e.target.value) || 0 })
                  }
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Expires (optional)</Label>
                <Input
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                  className="h-9"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Launch offer for early adopters"
                className="h-9"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || form.code.length < 3}
            >
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Create coupon
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// FEATURE FLAGS
// ============================================================

export function SaasFlagsTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.flags],
    queryFn: () =>
      api.get<{ globals: GlobalFlagRow[]; hotels: { id: string; name: string }[] }>(
        "/api/super-admin/feature-flags",
      ),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");

  const update = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put("/api/super-admin/feature-flags", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.flags] });
    },
    onError: (err) => onError(err, "Could not update the flag."),
  });

  const createFlag = useMutation({
    mutationFn: () => api.put("/api/super-admin/feature-flags", { key: newKey, enabled: false }),
    onSuccess: () => {
      toast({ title: "Flag created", description: "Disabled by default — enable it when ready." });
      setNewKey("");
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.flags] });
    },
    onError: (err) => onError(err, "Could not create the flag."),
  });

  const flags = data?.globals ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Feature Flags"
        description="Global defaults, scheduled activation and emergency kill switches. Backend entitlements enforce these on every request."
        action={
          <div className="flex gap-2">
            <Input
              placeholder="NEW_FLAG_KEY"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              className="h-9 w-44"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={newKey.length < 2}
              onClick={() => createFlag.mutate()}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add flag
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : flags.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No global flags"
          description="Add a flag key above to start controlling features platform-wide."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {flags.map((flag) => (
            <Card key={flag.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold truncate">{flag.key}</p>
                    {flag.description && (
                      <p className="text-[11px] text-muted-foreground truncate">
                        {flag.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge
                      variant={flag.enabled ? "default" : "secondary"}
                      className={
                        flag.enabled
                          ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                          : ""
                      }
                    >
                      {flag.enabled ? "ON" : "OFF"}
                    </Badge>
                    <Switch
                      checked={flag.enabled}
                      onCheckedChange={(enabled) => update.mutate({ key: flag.key, enabled })}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox
                      checked={flag.force}
                      onCheckedChange={(force) =>
                        update.mutate({ key: flag.key, force: force === true })
                      }
                    />
                    <span
                      className={flag.force ? "text-rose-600 font-medium" : "text-muted-foreground"}
                    >
                      Emergency force (overrides per-hotel)
                    </span>
                  </label>
                  {flag.activateAt && (
                    <Badge variant="outline">activates {formatDateTime(flag.activateAt)}</Badge>
                  )}
                  {flag.deactivateAt && (
                    <Badge variant="outline">deactivates {formatDateTime(flag.deactivateAt)}</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 pt-1 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      const at = window.prompt(
                        "Schedule activation (ISO date-time, e.g. 2026-01-01T09:00). Leave empty to clear:",
                        flag.activateAt?.slice(0, 16) ?? "",
                      );
                      if (at !== null)
                        update.mutate({
                          key: flag.key,
                          activateAt: at ? new Date(at).toISOString() : null,
                        });
                    }}
                  >
                    Schedule ON
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      const at = window.prompt(
                        "Schedule deactivation (ISO date-time). Leave empty to clear:",
                        flag.deactivateAt?.slice(0, 16) ?? "",
                      );
                      if (at !== null)
                        update.mutate({
                          key: flag.key,
                          deactivateAt: at ? new Date(at).toISOString() : null,
                        });
                    }}
                  >
                    Schedule OFF
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      const hotelName = window.prompt(
                        `Per-hotel override for ${flag.key} — enter hotel name (exact):`,
                      );
                      if (hotelName) {
                        const hotel = (data?.hotels ?? []).find((h) => h.name === hotelName);
                        if (!hotel) {
                          toast({
                            title: "Hotel not found",
                            description: "Use the exact hotel name.",
                            variant: "destructive",
                          });
                          return;
                        }
                        const enable = window.confirm(
                          `Enable ${flag.key} for ${hotel.name}? (Cancel = disable)`,
                        );
                        update.mutate({ key: flag.key, hotelId: hotel.id, enabled: enable });
                      }
                    }}
                  >
                    Per-hotel override
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Resolution order: emergency force → plan entitlement → per-hotel override → global default.
        Changes apply on the next request — no restart needed.
      </p>
    </div>
  );
}

// ============================================================
// BILLING
// ============================================================

export function SaasBillingTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.billing],
    queryFn: () =>
      api.get<{
        providers: Record<
          string,
          {
            enabled: boolean;
            mode: string;
            keyId: string | null;
            hasKeySecret: boolean;
            hasWebhookSecret: boolean;
            webhookUrl: string | null;
          }
        >;
        payments: PaymentRow[] | null;
        revenue: { collected: number; pending: number; refunded: number } | null;
      }>("/api/super-admin/billing?payments=1"),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [providerDialog, setProviderDialog] = useState<{ open: boolean; provider: string }>({
    open: false,
    provider: "",
  });
  const [form, setForm] = useState({
    keyId: "",
    keySecret: "",
    webhookSecret: "",
    mode: "test",
    enabled: true,
  });

  const saveProvider = useMutation({
    mutationFn: () =>
      api.put("/api/super-admin/billing", {
        provider: providerDialog.provider,
        keyId: form.keyId || undefined,
        keySecret: form.keySecret || undefined,
        webhookSecret: form.webhookSecret || undefined,
        mode: form.mode,
        enabled: form.enabled,
      }),
    onSuccess: () => {
      toast({
        title: "Provider saved",
        description: "Secrets are encrypted at rest and never shown again.",
      });
      setProviderDialog({ open: false, provider: "" });
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.billing] });
    },
    onError: (err) => onError(err, "Could not save the provider."),
  });

  const paymentAction = useMutation({
    mutationFn: (payload: { action: string; paymentId: string; reason: string; amount?: number }) =>
      api.post("/api/super-admin/billing", payload),
    onSuccess: () => {
      toast({ title: "Payment updated" });
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.billing] });
    },
    onError: (err) => onError(err, "Could not update the payment."),
  });

  function confirmPayment(payment: PaymentRow) {
    const reason = window.prompt(
      `Confirm payment ${payment.invoiceNumber} (${formatCurrency(payment.amount)}) as received?\n\nReason:`,
    );
    if (reason && reason.trim().length >= 3) {
      paymentAction.mutate({ action: "confirm", paymentId: payment.id, reason });
    }
  }
  function refundPayment(payment: PaymentRow) {
    const reason = window.prompt(
      `Refund payment ${payment.invoiceNumber}? This records a full refund.\n\nReason:`,
    );
    if (reason && reason.trim().length >= 3) {
      paymentAction.mutate({ action: "refund", paymentId: payment.id, reason });
    }
  }

  const providers = data?.providers ?? {};
  const payments = data?.payments ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Billing"
        description="Provider abstraction (Razorpay / Stripe / Manual). Secrets are AES-256-GCM encrypted and never returned to the browser."
      />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {(["razorpay", "stripe", "manual"] as const).map((key) => {
              const p = providers[key];
              return (
                <Card key={key}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center justify-between text-base capitalize">
                      <span className="flex items-center gap-2">
                        <CreditCard className="h-4 w-4" /> {key}
                      </span>
                      <Badge
                        variant={p?.enabled ? "default" : "secondary"}
                        className={
                          p?.enabled
                            ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
                            : ""
                        }
                      >
                        {p?.enabled ? "ENABLED" : "DISABLED"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs">
                      Mode: <b>{p?.mode ?? "test"}</b>
                    </p>
                    <p className="text-xs">
                      Key:{" "}
                      <span className="font-mono">
                        {key === "manual" ? "—" : (p?.keyId ?? "not set")}
                      </span>
                    </p>
                    <p className="text-xs">
                      Secrets:{" "}
                      <b>
                        {key === "manual" ? "n/a" : p?.hasKeySecret ? "configured ✓" : "missing ✗"}
                      </b>
                    </p>
                    <p className="text-xs">
                      Webhook:{" "}
                      <b>
                        {key === "manual"
                          ? "n/a"
                          : p?.hasWebhookSecret
                            ? "configured ✓"
                            : "missing ✗"}
                      </b>
                    </p>
                    {key !== "manual" && (
                      <p className="text-[10px] text-muted-foreground">
                        Webhook URL: /api/billing/webhook/{key}
                      </p>
                    )}
                    {key !== "manual" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full mt-1"
                        onClick={() => {
                          setForm({
                            keyId: "",
                            keySecret: "",
                            webhookSecret: "",
                            mode: p?.mode ?? "test",
                            enabled: p?.enabled ?? false,
                          });
                          setProviderDialog({ open: true, provider: key });
                        }}
                      >
                        Configure
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {data?.revenue && (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                title="Collected (all time)"
                value={formatCurrency(data.revenue.collected)}
                icon={IndianRupee}
                tone="emerald"
              />
              <StatCard
                title="Pending"
                value={formatCurrency(data.revenue.pending)}
                icon={CreditCard}
                tone="amber"
              />
              <StatCard
                title="Refunded"
                value={formatCurrency(data.revenue.refunded)}
                icon={RefreshCw}
                tone="rose"
              />
            </div>
          )}

          <SectionHeading
            title="Payments & Invoices"
            description="Manual confirmations for offline payments (bank transfer/UPI) and refunds."
          />
          {payments.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No payments yet"
              description="Hotel admins create checkouts from their Billing & Plan page."
            />
          ) : (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Hotel</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.invoiceNumber}</TableCell>
                        <TableCell className="text-sm">{p.hotelName}</TableCell>
                        <TableCell className="text-sm">
                          {formatCurrency(p.amount)}
                          {p.discountAmount > 0 && (
                            <p className="text-[10px] text-muted-foreground">
                              -{formatCurrency(p.discountAmount)}{" "}
                              {p.couponCode ? `(${p.couponCode})` : ""}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-xs capitalize">{p.provider}</TableCell>
                        <TableCell>
                          <StatusBadge status={p.status} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(p.paidAt ?? p.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {p.status === "PENDING" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => confirmPayment(p)}
                              >
                                Confirm
                              </Button>
                            )}
                            {(p.status === "PAID" || p.status === "PARTIALLY_REFUNDED") && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs text-rose-600"
                                onClick={() => refundPayment(p)}
                              >
                                Refund
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
          )}
        </>
      )}

      <Dialog
        open={providerDialog.open}
        onOpenChange={(o) => !o && setProviderDialog({ open: false, provider: "" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="capitalize">Configure {providerDialog.provider}</DialogTitle>
            <DialogDescription>
              Secrets are encrypted at rest and can be written but never read back. Leave a field
              empty to keep the stored value.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Key ID / publishable key</Label>
              <Input
                value={form.keyId}
                onChange={(e) => setForm({ ...form, keyId: e.target.value })}
                className="h-9 font-mono"
                placeholder="rzp_live_…"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Key secret <span className="text-muted-foreground">(write-only)</span>
              </Label>
              <Input
                type="password"
                value={form.keySecret}
                onChange={(e) => setForm({ ...form, keySecret: e.target.value })}
                className="h-9 font-mono"
                placeholder="leave empty to keep current"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Webhook secret <span className="text-muted-foreground">(write-only)</span>
              </Label>
              <Input
                type="password"
                value={form.webhookSecret}
                onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                className="h-9 font-mono"
                placeholder="leave empty to keep current"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Mode</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test">Test</SelectItem>
                    <SelectItem value="live">Live</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm self-end pb-2">
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                />
                Enabled
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProviderDialog({ open: false, provider: "" })}
            >
              Cancel
            </Button>
            <Button onClick={() => saveProvider.mutate()} disabled={saveProvider.isPending}>
              {saveProvider.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Save provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// USAGE & LIMITS
// ============================================================

export function SaasUsageTab() {
  const [hotelId, setHotelId] = useState("");
  const { data: hotelsData } = useQuery({
    queryKey: ["sa-usage-hotels"],
    queryFn: () =>
      api.get<{ hotels: { id: string; name: string }[] }>("/api/super-admin/feature-flags"),
  });
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.usage, hotelId],
    queryFn: () =>
      api.get<{ usage: { hotelId: string; hotelName: string; resources: UsageSummaryRow[] }[] }>(
        `/api/super-admin/usage${hotelId ? `?id=${hotelId}` : ""}`,
      ),
    enabled: true,
  });

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Usage & Limits"
        description="Live resource consumption vs plan limits. Warning states at 75% / 90% / 100%."
        action={
          <Select value={hotelId} onValueChange={setHotelId}>
            <SelectTrigger className="w-56 h-9">
              <SelectValue placeholder="All hotels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All hotels</SelectItem>
              {(hotelsData?.hotels ?? []).map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : !data?.usage || data.usage.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No usage data"
          description="Usage appears as hotels use the platform."
        />
      ) : (
        data.usage.map((hotel) => (
          <Card key={hotel.hotelId}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{hotel.hotelName}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {hotel.resources.map((r) => (
                <div key={r.resource} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="capitalize">
                      {r.resource.replace(/([A-Z])/g, " $1").toLowerCase()}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatNumber(r.used)} / {r.limit ? formatNumber(r.limit) : "∞"}
                    </span>
                  </div>
                  <Progress value={r.percent} className="h-2" />
                  <p
                    className={`text-[10px] ${r.percent >= 100 ? "text-rose-600 font-medium" : r.percent >= 90 ? "text-amber-600" : "text-muted-foreground"}`}
                  >
                    {r.limit
                      ? `${r.percent}% used${r.remaining !== null ? ` — ${formatNumber(r.remaining)} remaining` : ""}`
                      : "unlimited"}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ============================================================
// SECURITY CENTRE
// ============================================================

export function SaasSecurityTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.security],
    queryFn: () =>
      api.get<{
        overview: {
          failedLogins24h: number;
          lockouts24h: number;
          rateLimited24h: number;
          csrfBlocked24h: number;
          suspicious24h: number;
          mfaDisabled7d: number;
          sessionRevoked7d: number;
          unreviewedCritical: number;
          mfaAdoption: number;
          recentEvents: SecurityEventRow[];
        };
        mfaPolicy: { requiredRoles: string[] };
        securitySettings: { blockedIps: string[] };
      }>("/api/super-admin/security"),
    refetchInterval: 30000,
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [blockIp, setBlockIp] = useState("");
  const [roleToggles, setRoleToggles] = useState<Record<string, boolean> | null>(null);

  const action = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post("/api/super-admin/security", payload),
    onSuccess: (_res, vars) => {
      const act = (vars as { action: string }).action;
      toast({
        title:
          act === "block-ip"
            ? "IP blocked"
            : act === "unblock-ip"
              ? "IP unblocked"
              : "Action completed",
      });
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.security] });
    },
    onError: (err) => onError(err, "Could not perform the security action."),
  });

  const saveMfaPolicy = useMutation({
    mutationFn: (requiredRoles: string[]) =>
      api.put("/api/super-admin/settings", { key: "mfa.policy", value: { requiredRoles } }),
    onSuccess: () => {
      toast({
        title: "MFA policy saved",
        description: "Affected users must enrol at next sign-in (restricted sessions).",
      });
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.security] });
    },
    onError: (err) => onError(err, "Could not save the MFA policy."),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const overview = data?.overview;
  if (!overview)
    return (
      <EmptyState
        icon={Shield}
        title="No security data"
        description="Security events appear as the platform is used."
      />
    );

  const allRoles = [
    "SUPER_ADMIN",
    "HOTEL_OWNER",
    "HOTEL_ADMIN",
    "HOTEL_MANAGER",
    "MARKETING_MANAGER",
    "RESTAURANT_MANAGER",
    "FRONT_DESK",
    "HOTEL_STAFF",
  ];
  const requiredRoles =
    roleToggles ??
    Object.fromEntries(allRoles.map((r) => [r, (data?.mfaPolicy.requiredRoles ?? []).includes(r)]));

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Security Centre"
        description="Failed logins, lockouts, sessions, IP controls and MFA policy — all live from the database."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Failed logins (24h)"
          value={overview.failedLogins24h}
          icon={XCircle}
          tone="rose"
        />
        <StatCard
          title="Account lockouts (24h)"
          value={overview.lockouts24h}
          icon={Ban}
          tone="rose"
        />
        <StatCard
          title="Rate-limited (24h)"
          value={overview.rateLimited24h}
          icon={AlertTriangle}
          tone="amber"
        />
        <StatCard
          title="CSRF blocked (24h)"
          value={overview.csrfBlocked24h}
          icon={Shield}
          tone="violet"
        />
        <StatCard
          title="Suspicious activity"
          value={overview.suspicious24h}
          icon={AlertTriangle}
          tone="amber"
          delay={0.05}
        />
        <StatCard
          title="MFA disabled (7d)"
          value={overview.mfaDisabled7d}
          icon={KeyRound}
          tone="rose"
          delay={0.1}
        />
        <StatCard
          title="Sessions revoked (7d)"
          value={overview.sessionRevoked7d}
          icon={RefreshCw}
          tone="default"
          delay={0.15}
        />
        <StatCard
          title="MFA adoption"
          value={`${overview.mfaAdoption}%`}
          icon={CheckCircle2}
          tone="emerald"
          delay={0.2}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">MFA policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Selected roles MUST enrol in TOTP MFA. Until they do, sign-in sessions are restricted
              to MFA enrolment routes only.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {allRoles.map((role) => (
                <label key={role} className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={requiredRoles[role]}
                    onCheckedChange={(checked) =>
                      setRoleToggles({ ...requiredRoles, [role]: checked === true })
                    }
                  />
                  {role.replace(/_/g, " ")}
                </label>
              ))}
            </div>
            <Button
              size="sm"
              onClick={() =>
                saveMfaPolicy.mutate(
                  Object.entries(requiredRoles)
                    .filter(([, v]) => v)
                    .map(([k]) => k),
                )
              }
              disabled={saveMfaPolicy.isPending || roleToggles === null}
            >
              {saveMfaPolicy.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              Save MFA policy
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Blocked IP addresses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={blockIp}
                onChange={(e) => setBlockIp(e.target.value)}
                placeholder="e.g. 203.0.113.5"
                className="h-9 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!blockIp.trim()}
                onClick={() => {
                  const reason = window.prompt(`Block ${blockIp}? Reason required:`);
                  if (reason && reason.trim().length >= 3) {
                    action.mutate({ action: "block-ip", ip: blockIp.trim(), reason });
                    setBlockIp("");
                  }
                }}
              >
                Block IP
              </Button>
            </div>
            {(data?.securitySettings.blockedIps ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No blocked IPs.</p>
            ) : (
              <div className="space-y-1.5">
                {data?.securitySettings.blockedIps.map((ip) => (
                  <div
                    key={ip}
                    className="flex items-center justify-between rounded-lg border px-3 py-1.5"
                  >
                    <span className="font-mono text-xs">{ip}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs"
                      onClick={() => action.mutate({ action: "unblock-ip", ip })}
                    >
                      Unblock
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <SectionHeading
        title="Recent security events"
        description={
          overview.unreviewedCritical > 0
            ? `${overview.unreviewedCritical} unreviewed critical events`
            : "All critical events reviewed"
        }
      />
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Time</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.recentEvents.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs font-medium">{e.type.replace(/_/g, " ")}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        e.severity === "CRITICAL"
                          ? "destructive"
                          : e.severity === "WARNING"
                            ? "outline"
                            : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {e.severity}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{e.email ?? "—"}</TableCell>
                  <TableCell className="text-xs font-mono">{e.ipAddress ?? "—"}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    {e.reviewedAt ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-emerald-500/10 text-emerald-600"
                      >
                        Reviewed
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        onClick={() => action.mutate({ action: "review-event", eventId: e.id })}
                      >
                        Mark reviewed
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// BACKUPS
// ============================================================

export function SaasBackupsTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.backups],
    queryFn: () =>
      api.get<{
        status: {
          config: {
            enabled: boolean;
            scheduleHours: number;
            retentionCount: number;
            verify: boolean;
          };
          lastSuccess: {
            filename: string | null;
            sizeBytes: number;
            verified: boolean;
            finishedAt: string | null;
            durationMs: number;
          } | null;
          lastFailed: { error: string | null; finishedAt: string | null } | null;
          nextBackup: string | null;
          successCount: number;
          pendingCount: number;
        };
        history: BackupHistoryRow[];
      }>("/api/super-admin/backups"),
    refetchInterval: 60000,
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();

  const trigger = useMutation({
    mutationFn: (reason: string) =>
      api.post<{
        ok: boolean;
        status: string;
        filename: string | null;
        sizeBytes: number;
        error: string | null;
      }>("/api/super-admin/backups", { reason }),
    onSuccess: (res: { ok: boolean; status: string; error: string | null }) => {
      const queued = res.status === "QUEUED";
      toast({
        title: res.ok ? (queued ? "Backup queued" : "Backup completed") : "Backup failed",
        description: res.ok
          ? queued
            ? "The worker is generating the encrypted backup — it will appear in the history below shortly."
            : "Encrypted and recorded with a checksum."
          : (res.error ?? "Check the backup history for details."),
        variant: res.ok ? "default" : "destructive",
      });
      // Refresh shortly after: the worker processes the queued record within seconds.
      if (queued) {
        setTimeout(
          () => void queryClient.invalidateQueries({ queryKey: [queryClientKeys.backups] }),
          8000,
        );
        setTimeout(
          () => void queryClient.invalidateQueries({ queryKey: [queryClientKeys.backups] }),
          30000,
        );
      }
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.backups] });
    },
    onError: (err) => onError(err, "Could not run the backup."),
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/super-admin/backups?verify=1", {}),
    onSuccess: (res: { ok: boolean }) => {
      toast({
        title: res.ok ? "Backup verified" : "Verification failed",
        description: res.ok
          ? "The archive decrypts and matches its checksum."
          : "The archive could not be verified.",
        variant: res.ok ? "default" : "destructive",
      });
    },
    onError: (err) => onError(err, "Could not verify the backup."),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const status = data?.status;
  if (!status)
    return (
      <EmptyState
        icon={DatabaseBackup}
        title="No backup data"
        description="Trigger a backup to get started."
      />
    );

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Backups & Disaster Recovery"
        description="Encrypted (AES-256-GCM) backups with checksums and verification. Raw credentials are never exposed."
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
            >
              {verify.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-1.5" />
              )}
              Verify last
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const reason = window.prompt("Reason for this manual backup:");
                if (reason && reason.trim().length >= 3) trigger.mutate(reason.trim());
              }}
              disabled={trigger.isPending}
            >
              {trigger.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <DatabaseBackup className="h-4 w-4 mr-1.5" />
              )}
              Run backup now
            </Button>
          </div>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Last successful"
          value={
            status.lastSuccess ? formatDateTime(status.lastSuccess.finishedAt).split(",")[0] : "—"
          }
          hint={status.lastSuccess?.filename ?? undefined}
          icon={CheckCircle2}
          tone="emerald"
        />
        <StatCard
          title="Last failure"
          value={status.lastFailed ? "Failed" : "None"}
          hint={status.lastFailed?.error ?? undefined}
          icon={XCircle}
          tone={status.lastFailed ? "rose" : "default"}
        />
        <StatCard
          title="Next scheduled"
          value={status.nextBackup ? formatDateTime(status.nextBackup).split(",")[0] : "—"}
          hint={status.config.enabled ? `every ${status.config.scheduleHours}h` : "scheduling off"}
          icon={RefreshCw}
          tone="default"
        />
        <StatCard
          title="Successful backups"
          value={status.successCount}
          hint={`retention: ${status.config.retentionCount}`}
          icon={DatabaseBackup}
          tone="violet"
        />
      </div>

      <SectionHeading title="Backup history" />
      {(data?.history ?? []).length === 0 ? (
        <EmptyState
          icon={DatabaseBackup}
          title="No backups yet"
          description="Run your first backup above or enable scheduled backups in Platform Settings."
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Verified</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Finished</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.history ?? []).map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] max-w-56 truncate">
                      {b.filename ?? b.error ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.sizeBytes ? `${(b.sizeBytes / 1024).toFixed(1)} KB` : "—"}
                    </TableCell>
                    <TableCell>
                      {b.verified ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.durationMs ? `${(b.durationMs / 1000).toFixed(1)}s` : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(b.finishedAt ?? b.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// NOTIFICATION TEMPLATES
// ============================================================

export function SaasTemplatesTab() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.templates],
    queryFn: () => api.get<{ templates: NotificationTemplateRow[] }>("/api/super-admin/templates"),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);

  const save = useMutation({
    mutationFn: (payload: { key: string; subject: string; body: string; isActive: boolean }) =>
      api.put("/api/super-admin/templates", payload),
    onSuccess: () => {
      toast({ title: "Template saved" });
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.templates] });
    },
    onError: (err) => onError(err, "Could not save the template."),
  });

  const templates = data?.templates ?? [];
  const selected = templates.find((t) => t.key === selectedKey) ?? null;

  function openTemplate(t: NotificationTemplateRow) {
    setSelectedKey(t.key);
    setDraft({ subject: t.subject ?? "", body: t.body });
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Notification Templates"
        description="Trial, billing and security messages with {{variables}} — validated before saving."
      />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No templates"
          description="Reload — default templates are seeded automatically."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => openTemplate(t)}
                className={`w-full text-left rounded-xl border p-3 transition-colors hover:bg-accent ${selectedKey === t.key ? "border-primary bg-primary/5" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{t.name}</p>
                  <Badge variant={t.isActive ? "default" : "secondary"} className="text-[10px]">
                    {t.channel}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground font-mono">{t.key}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                  {t.subject ?? t.body}
                </p>
              </button>
            ))}
          </div>
          {selected && draft && (
            <Card className="h-fit sticky top-0">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  Edit — {selected.name}
                  <Badge
                    variant={selected.isActive ? "default" : "secondary"}
                    className="text-[10px]"
                  >
                    {selected.isActive ? "Active" : "Inactive"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Subject</Label>
                  <Input
                    value={draft.subject}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Body</Label>
                  <Textarea
                    rows={10}
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {selected.supportedVariables.map((v) => (
                    <Badge
                      key={v}
                      variant="outline"
                      className="text-[10px] cursor-pointer hover:bg-accent"
                      onClick={() => setDraft({ ...draft, body: `${draft.body}{{${v}}}` })}
                    >
                      {`{{${v}}}`}
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      save.mutate({
                        key: selected.key,
                        subject: draft.subject,
                        body: draft.body,
                        isActive: selected.isActive,
                      })
                    }
                    disabled={save.isPending}
                  >
                    {save.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                    ) : (
                      <Save className="h-4 w-4 mr-1.5" />
                    )}
                    Save template
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDraft(null)}>
                    <X className="h-4 w-4 mr-1" /> Close
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PLATFORM SETTINGS
// ============================================================

export function SaasSettingsTab() {
  const { data, isLoading } = useQuery({
    queryKey: [queryClientKeys.settings],
    queryFn: () =>
      api.get<{
        settings: {
          "trial.defaults": {
            defaultDays: number;
            minDays: number;
            maxDays: number;
            graceDays: number;
            autoExpire: boolean;
            blockOnExpiry: boolean;
          };
          maintenance: { enabled: boolean; message: string };
          backup: {
            enabled: boolean;
            scheduleHours: number;
            retentionCount: number;
            verify: boolean;
          };
          privacy: { auditRetentionMonths: number; securityEventRetentionMonths: number };
        };
      }>("/api/super-admin/settings"),
  });
  const { toast } = useToast();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [announcement, setAnnouncement] = useState({
    title: "",
    message: "",
    severity: "INFO",
    audience: "all",
  });

  const save = useMutation({
    mutationFn: (payload: { key: string; value: unknown }) =>
      api.put("/api/super-admin/settings", payload),
    onSuccess: (res, vars) => {
      toast({
        title: "Setting saved",
        description:
          vars.key === "maintenance"
            ? "Maintenance mode toggled — tenant APIs respond accordingly."
            : "The change is live immediately.",
      });
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: [queryClientKeys.settings] });
    },
    onError: (err) => onError(err, "Could not save the setting."),
  });

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; recipients: number }>("/api/super-admin/announcements", announcement),
    onSuccess: (res: { recipients: number }) => {
      toast({
        title: "Announcement published",
        description: `Delivered to ${res.recipients} hotel notification inboxes.`,
      });
      setAnnouncement({ title: "", message: "", severity: "INFO", audience: "all" });
    },
    onError: (err) => onError(err, "Could not publish the announcement."),
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  const settings = data?.settings;
  if (!settings)
    return (
      <EmptyState icon={Settings2} title="Settings unavailable" description="Reload the page." />
    );

  const trial =
    (draft?.["trial.defaults"] as (typeof settings)["trial.defaults"]) ??
    settings["trial.defaults"];
  const maintenance = (draft?.maintenance as typeof settings.maintenance) ?? settings.maintenance;
  const backup = (draft?.backup as typeof settings.backup) ?? settings.backup;
  const privacy = (draft?.privacy as typeof settings.privacy) ?? settings.privacy;

  const numField = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    min = 0,
    max = 365,
  ) => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="h-9"
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Platform Settings"
        description="Trial defaults, maintenance mode, backups and retention. Every change is audited and enforced server-side."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Trial defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {numField("Default trial days", trial.defaultDays, (n) =>
              setDraft({ ...draft, "trial.defaults": { ...trial, defaultDays: n } }),
            )}
            {numField(
              "Minimum days",
              trial.minDays,
              (n) => setDraft({ ...draft, "trial.defaults": { ...trial, minDays: n } }),
              0,
              90,
            )}
            {numField(
              "Maximum days",
              trial.maxDays,
              (n) => setDraft({ ...draft, "trial.defaults": { ...trial, maxDays: n } }),
              1,
              365,
            )}
            {numField(
              "Grace days",
              trial.graceDays,
              (n) => setDraft({ ...draft, "trial.defaults": { ...trial, graceDays: n } }),
              0,
              90,
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={trial.autoExpire}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, "trial.defaults": { ...trial, autoExpire: v } })
                }
              />
              Auto-expire trials (worker)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={trial.blockOnExpiry}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, "trial.defaults": { ...trial, blockOnExpiry: v } })
                }
              />
              Block expired tenants from core APIs
            </label>
          </div>
          <Button
            size="sm"
            onClick={() => save.mutate({ key: "trial.defaults", value: trial })}
            disabled={save.isPending || draft?.["trial.defaults"] === undefined}
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Save trial defaults
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            Maintenance mode
            {maintenance.enabled && (
              <Badge variant="destructive" className="text-[10px]">
                ACTIVE — tenants blocked
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={maintenance.enabled}
              onCheckedChange={(v) =>
                setDraft({ ...draft, maintenance: { ...maintenance, enabled: v } })
              }
            />
            Enable maintenance mode
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Message shown to tenants (503)</Label>
            <Input
              value={maintenance.message}
              onChange={(e) =>
                setDraft({ ...draft, maintenance: { ...maintenance, message: e.target.value } })
              }
              className="h-9"
            />
          </div>
          <Button
            size="sm"
            variant={maintenance.enabled ? "destructive" : "default"}
            onClick={() => save.mutate({ key: "maintenance", value: maintenance })}
            disabled={save.isPending || draft?.maintenance === undefined}
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            {maintenance.enabled ? "Save (maintenance ON)" : "Save (maintenance off)"}
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Backup schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Switch
                checked={backup.enabled}
                onCheckedChange={(v) => setDraft({ ...draft, backup: { ...backup, enabled: v } })}
              />
              Scheduled encrypted backups
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numField(
                "Every (hours)",
                backup.scheduleHours,
                (n) => setDraft({ ...draft, backup: { ...backup, scheduleHours: n } }),
                1,
                720,
              )}
              {numField(
                "Retention count",
                backup.retentionCount,
                (n) => setDraft({ ...draft, backup: { ...backup, retentionCount: n } }),
                1,
                100,
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={backup.verify}
                onCheckedChange={(v) => setDraft({ ...draft, backup: { ...backup, verify: v } })}
              />
              Verify every backup
            </label>
            <Button
              size="sm"
              onClick={() => save.mutate({ key: "backup", value: backup })}
              disabled={save.isPending || draft?.backup === undefined}
            >
              Save backup settings
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Data retention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {numField(
                "Audit logs (months)",
                privacy.auditRetentionMonths,
                (n) => setDraft({ ...draft, privacy: { ...privacy, auditRetentionMonths: n } }),
                1,
                120,
              )}
              {numField(
                "Security events (months)",
                privacy.securityEventRetentionMonths,
                (n) =>
                  setDraft({ ...draft, privacy: { ...privacy, securityEventRetentionMonths: n } }),
                1,
                120,
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              The background worker purges older records on its housekeeping sweep.
            </p>
            <Button
              size="sm"
              onClick={() => save.mutate({ key: "privacy", value: privacy })}
              disabled={save.isPending || draft?.privacy === undefined}
            >
              Save retention settings
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Global announcement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Severity</Label>
              <Select
                value={announcement.severity}
                onValueChange={(v) => setAnnouncement({ ...announcement, severity: v })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="WARNING">Warning</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Audience</Label>
              <Select
                value={announcement.audience}
                onValueChange={(v) => setAnnouncement({ ...announcement, audience: v })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All active hotels</SelectItem>
                  <SelectItem value="trial">Trial hotels</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Title</Label>
              <Input
                value={announcement.title}
                onChange={(e) => setAnnouncement({ ...announcement, title: e.target.value })}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Message</Label>
            <Textarea
              rows={3}
              value={announcement.message}
              onChange={(e) => setAnnouncement({ ...announcement, message: e.target.value })}
            />
          </div>
          <Button
            size="sm"
            onClick={() => publish.mutate()}
            disabled={
              publish.isPending || announcement.title.length < 3 || announcement.message.length < 3
            }
          >
            {publish.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <Send className="h-4 w-4 mr-1.5" />
            )}
            Publish announcement
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
