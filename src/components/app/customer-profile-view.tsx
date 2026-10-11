"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomerProfile, VisitRow, ViewId } from "@/lib/types";
import { VisitDialog } from "./visit-dialog";
import { CustomerDialog } from "./customer-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Phone,
  Mail,
  CalendarCheck,
  CalendarDays,
  Repeat,
  Pencil,
  BellRing,
  BellOff,
  Loader2,
  History,
  UserRoundX,
  UserRoundCheck,
  Trash2,
  Clock,
  UserPlus,
  CheckCircle2,
  XCircle,
  Sparkles,
  Import,
  Crown,
  MapPin,
  Cake,
  Heart,
  BedDouble,
  UtensilsCrossed,
  NotebookPen,
  Wallet,
  Send,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatDateTime, formatRelative, initials, phoneDisplay } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CustomerProfileView({
  customerId,
  onBack,
  setView,
}: {
  customerId: string;
  onBack: () => void;
  setView: (v: ViewId) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [visitOpen, setVisitOpen] = useState(false);
  const [editingVisit, setEditingVisit] = useState<VisitRow | null>(null);
  const [deletingVisit, setDeletingVisit] = useState<VisitRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    "opt_in" | "opt_out" | "deactivate" | "reactivate" | null
  >(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => api.get<CustomerProfile>(`/api/customers/${customerId}`),
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    queryClient.invalidateQueries({ queryKey: ["visits"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["audit"] });
  }

  const actionMutation = useMutation({
    mutationFn: async () => {
      if (confirmAction === "opt_in") return api.post(`/api/customers/${customerId}/consent`, {});
      if (confirmAction === "opt_out") return api.post(`/api/customers/${customerId}/opt-out`, {});
      if (confirmAction === "deactivate") return api.delete(`/api/customers/${customerId}`);
      return api.patch(`/api/customers/${customerId}`, { status: "ACTIVE" });
    },
    onSuccess: () => {
      invalidateAll();
      const labels: Record<string, [string, string]> = {
        opt_in: ["Consent recorded", "This guest can now receive marketing offers."],
        opt_out: ["Opt-out recorded", "This guest will no longer receive marketing."],
        deactivate: ["Customer deactivated", "History is preserved. You can reactivate anytime."],
        reactivate: ["Customer reactivated", "The guest is active again."],
      };
      const [title, desc] = labels[confirmAction || ""] || ["Done", ""];
      toast({ title, description: desc });
      setConfirmAction(null);
    },
    onError: (err) => {
      toast({
        title: "Action failed",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteVisitMutation = useMutation({
    mutationFn: (v: VisitRow) => api.delete(`/api/visits/${v.id}`),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Visit deleted", description: "The visit record was removed." });
      setDeletingVisit(null);
    },
    onError: (err) => {
      toast({
        title: "Could not delete visit",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-44 rounded-2xl" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border bg-card p-10 text-center">
        <p className="font-semibold">Customer not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This customer doesn&apos;t exist in your hotel, or you don&apos;t have access.
        </p>
        <Button className="mt-5" variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back to customers
        </Button>
      </div>
    );
  }

  const { customer, stats, visits, timeline, segments } = data;
  const isActive = customer.status === "ACTIVE";

  return (
    <div className="space-y-5">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> All customers
      </button>

      {/* Header card */}
      <Card className="overflow-hidden">
        <div className="h-20 bg-[linear-gradient(120deg,oklch(0.96_0.03_75),oklch(0.93_0.05_65))] dark:bg-[linear-gradient(120deg,oklch(0.28_0.04_55),oklch(0.32_0.05_50))]" />
        <CardContent className="px-6 pb-6 -mt-10">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <Avatar className="h-20 w-20 border-4 border-card shadow-sm">
              <AvatarFallback className="bg-primary text-primary-foreground text-xl font-bold">
                {initials(customer.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-bold tracking-tight">{customer.name}</h2>
                {customer.vip && (
                  <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-0">
                    <Crown className="h-3 w-3 mr-1" /> VIP
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={cn(
                    isActive
                      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5"
                      : "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  {isActive ? "Active" : "Inactive"}
                </Badge>
                {customer.campaignEligible ? (
                  <Badge className="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-0">
                    <Sparkles className="h-3 w-3 mr-1" /> Campaign eligible
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-muted-foreground">
                    Not campaign eligible
                  </Badge>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" /> {phoneDisplay(customer.phone)}
                </span>
                {customer.email && (
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5" /> {customer.email}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <UserPlus className="h-3.5 w-3.5" /> Added {formatRelative(customer.createdAt)}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setEditingVisit(null);
                  setVisitOpen(true);
                }}
              >
                <CalendarCheck className="h-4 w-4" /> Add visit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              {customer.optOut || !customer.marketingConsent ? (
                <Button size="sm" variant="outline" onClick={() => setConfirmAction("opt_in")}>
                  <BellRing className="h-4 w-4" /> Record consent
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmAction("opt_out")}>
                  <BellOff className="h-4 w-4" /> Opt out
                </Button>
              )}
              {isActive ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmAction("deactivate")}
                >
                  <UserRoundX className="h-4 w-4" /> Deactivate
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmAction("reactivate")}>
                  <UserRoundCheck className="h-4 w-4" /> Reactivate
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Consent banner */}
      {customer.optOut && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <XCircle className="h-5 w-5 text-rose-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">
              This guest has opted out of marketing
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              marketing_consent = false · opt_out = true — future campaigns will automatically skip
              this guest.
            </p>
          </div>
        </div>
      )}
      {!customer.optOut && !customer.marketingConsent && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <Clock className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              No marketing consent recorded yet
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ask the guest for permission before adding them to any future campaign. Record it with
              the &quot;Record consent&quot; button once they agree.
            </p>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { icon: CalendarCheck, label: "Total visits", value: String(stats.totalVisits) },
          {
            icon: Wallet,
            label: "Lifetime spend",
            value: stats.totalSpend > 0 ? `₹${stats.totalSpend.toLocaleString("en-IN")}` : "—",
          },
          { icon: CalendarDays, label: "First visit", value: formatDate(stats.firstVisit) },
          { icon: Clock, label: "Last visit", value: formatDate(stats.lastVisit) },
          {
            icon: Repeat,
            label: "Guest type",
            value:
              stats.totalVisits >= 2
                ? "Repeat guest"
                : stats.totalVisits === 1
                  ? "New guest"
                  : "No visits yet",
          },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <s.icon className="h-4 w-4" />
              <p className="text-xs font-medium">{s.label}</p>
            </div>
            <p className="mt-2 text-lg font-bold tracking-tight">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Segment badges (Phase 2) */}
      {segments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground mr-1">Segments:</p>
          {segments.map((s) => (
            <Badge key={s.id} variant="secondary" className="text-[11px]">
              {s.name}
              {s.type === "AUTO" && (
                <span className="ml-1 text-[9px] text-muted-foreground">AUTO</span>
              )}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Timeline */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <History className="h-4 w-4 text-primary" /> Activity timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative ml-3 border-l-2 border-border space-y-6 pb-1">
              {timeline.map((t, i) => (
                <li key={i} className="relative pl-6">
                  <span
                    className={cn(
                      "absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-card",
                      t.type === "visit" && "bg-amber-500",
                      t.type === "customer_created" && "bg-primary",
                      t.type === "consent_granted" && "bg-emerald-500",
                      t.type === "opt_out" && "bg-rose-500",
                      t.type === "campaign_message" && "bg-violet-500",
                    )}
                  />
                  <p className="text-[13.5px] font-semibold leading-tight flex items-center gap-1.5">
                    {t.type === "campaign_message" && <Send className="h-3 w-3 text-violet-500" />}
                    {t.label}
                    {t.amount != null && t.amount > 0 && (
                      <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                        ₹{t.amount.toLocaleString("en-IN")}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDateTime(t.timestamp)}
                  </p>
                  {t.detail && (
                    <p className="mt-1 text-[11px] text-muted-foreground/80 inline-flex items-center gap-1">
                      {t.detail.includes("Imported") ? (
                        <Import className="h-3 w-3" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      {t.detail}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Visits list */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <CalendarCheck className="h-4 w-4 text-primary" /> Visit history
              <Badge variant="secondary" className="ml-auto tabular-nums">
                {visits.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {visits.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-3">
                  <CalendarCheck className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold">No visits recorded yet</p>
                <p className="mt-1 text-xs text-muted-foreground max-w-xs">
                  Record this guest&apos;s first visit to start building their history.
                </p>
                <Button
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    setEditingVisit(null);
                    setVisitOpen(true);
                  }}
                >
                  <CalendarCheck className="h-4 w-4" /> Record first visit
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {visits.map((v, idx) => (
                  <li key={v.id} className="flex items-center gap-4 px-6 py-3.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-600 text-[11px] font-bold">
                      #{visits.length - idx}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold">
                        {formatDateTime(v.checkin)}
                        {v.checkout && (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            → {formatDateTime(v.checkout)}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                        {v.source === "CSV_IMPORT" && (
                          <span className="inline-flex items-center gap-1">
                            <Import className="h-3 w-3" /> CSV import
                          </span>
                        )}
                        {v.notes && <span className="truncate max-w-[280px]">· {v.notes}</span>}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="Edit visit"
                        onClick={() => {
                          setEditingVisit({ ...v, customerId });
                          setVisitOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        aria-label="Delete visit"
                        onClick={() => setDeletingVisit(v)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Consent details card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <BellRing className="h-4 w-4 text-primary" /> Marketing consent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Consent status</p>
              <p className="mt-1 font-semibold">
                {customer.optOut
                  ? "Opted out"
                  : customer.marketingConsent
                    ? "Opted in"
                    : "Not given"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Consent date</p>
              <p className="mt-1 font-semibold">{formatDateTime(customer.consentTimestamp)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="mt-1 font-semibold">{customer.consentSource || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Campaign eligibility</p>
              <p
                className={cn(
                  "mt-1 font-semibold",
                  customer.campaignEligible
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {customer.campaignEligible ? "Eligible" : "Blocked"}
              </p>
            </div>
          </div>
          <Separator />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Campaigns (Phase 2) automatically check these flags before any message is sent — guests
            with opt-out = true or no consent are always skipped and reported.
          </p>
        </CardContent>
      </Card>

      {/* Guest intelligence (Phase 2) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <Sparkles className="h-4 w-4 text-primary" /> Guest intelligence
            <span className="text-xs font-normal text-muted-foreground">
              — powers segmentation &amp; personalisation
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <Detail icon={BedDouble} label="Room preference" value={customer.roomPreference} />
            <Detail
              icon={UtensilsCrossed}
              label="Food preference"
              value={customer.foodPreference}
            />
            <Detail icon={MapPin} label="Location" value={customer.location} />
            <Detail
              icon={UserPlus}
              label="Source"
              value={
                customer.source
                  ? ({
                      WALK_IN: "Walk-in",
                      BOOKING: "Booking",
                      WEBSITE: "Website",
                      REFERRAL: "Referral",
                      OTHER: "Other",
                    }[customer.source] ?? customer.source)
                  : null
              }
            />
            <Detail
              icon={Cake}
              label="Birthday"
              value={customer.birthday ? formatDate(customer.birthday) : null}
            />
            <Detail
              icon={Heart}
              label="Anniversary"
              value={customer.anniversary ? formatDate(customer.anniversary) : null}
            />
            <Detail
              icon={Wallet}
              label="Lifetime spend"
              value={stats.totalSpend > 0 ? `₹${stats.totalSpend.toLocaleString("en-IN")}` : null}
            />
            <Detail icon={Crown} label="VIP status" value={customer.vip ? "VIP guest" : null} />
          </div>
          {customer.notes && (
            <div className="rounded-lg bg-accent/40 border px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
                <NotebookPen className="h-3.5 w-3.5" /> Notes
              </p>
              <p className="text-sm whitespace-pre-wrap">{customer.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <VisitDialog
        open={visitOpen}
        onOpenChange={setVisitOpen}
        editing={editingVisit}
        presetCustomer={
          editingVisit
            ? null
            : {
                id: customer.id,
                name: customer.name,
                phone: customer.phone,
                email: customer.email,
                marketingConsent: customer.marketingConsent,
                optOut: customer.optOut,
                consentTimestamp: customer.consentTimestamp,
                status: customer.status,
                createdAt: customer.createdAt,
                totalVisits: stats.totalVisits,
                lastVisit: stats.lastVisit,
                campaignEligible: customer.campaignEligible,
              }
        }
      />
      <CustomerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={{
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          marketingConsent: customer.marketingConsent,
          optOut: customer.optOut,
          consentTimestamp: customer.consentTimestamp,
          status: customer.status,
          createdAt: customer.createdAt,
          totalVisits: stats.totalVisits,
          lastVisit: stats.lastVisit,
          campaignEligible: customer.campaignEligible,
          vip: customer.vip,
          totalSpend: stats.totalSpend,
        }}
      />

      {/* VIP quick toggle */}
      <VipToggleCard vip={customer.vip} customerId={customer.id} name={customer.name} />

      {/* Confirmations */}
      <AlertDialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "opt_in" && `Record consent from ${customer.name}?`}
              {confirmAction === "opt_out" && `Opt ${customer.name} out of marketing?`}
              {confirmAction === "deactivate" && `Deactivate ${customer.name}?`}
              {confirmAction === "reactivate" && `Reactivate ${customer.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "opt_in" &&
                "Only confirm if the guest has actually agreed to receive promotional offers from your hotel."}
              {confirmAction === "opt_out" &&
                "marketing_consent will be set to false and opt_out to true. Future campaigns will skip this guest automatically."}
              {confirmAction === "deactivate" &&
                "The guest will be marked inactive but their history is preserved."}
              {confirmAction === "reactivate" &&
                "The guest will return to your active customer list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                (confirmAction === "opt_out" || confirmAction === "deactivate") &&
                  "bg-destructive text-white hover:bg-destructive/90",
              )}
              disabled={actionMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                actionMutation.mutate();
              }}
            >
              {actionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete visit confirmation */}
      <AlertDialog open={!!deletingVisit} onOpenChange={(o) => !o && setDeletingVisit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this visit?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingVisit && (
                <>
                  Visit on{" "}
                  <span className="font-medium">{formatDateTime(deletingVisit.checkin)}</span> will
                  be permanently removed. Total visit count will update automatically.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleteVisitMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deletingVisit) deleteVisitMutation.mutate(deletingVisit);
              }}
            >
              {deleteVisitMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Trash2 className="h-4 w-4" /> Delete visit
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Detail({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className={cn("mt-1 font-semibold", !value && "text-muted-foreground font-normal")}>
        {value ?? "—"}
      </p>
    </div>
  );
}

function VipToggleCard({
  vip,
  customerId,
  name,
}: {
  vip: boolean;
  customerId: string;
  name: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.patch(`/api/customers/${customerId}`, { vip: !vip }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: vip ? "Removed from VIP" : "Marked as VIP",
        description: vip
          ? `${name} is no longer flagged VIP.`
          : `${name} now belongs to the VIP segment.`,
      });
    },
    onError: () => toast({ title: "Could not update VIP status", variant: "destructive" }),
  });
  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
        vip
          ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      {mutation.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Crown className="h-4 w-4" />
      )}
      {vip ? "VIP — click to remove flag" : "Flag as VIP guest"}
    </button>
  );
}
