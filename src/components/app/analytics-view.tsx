"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { AnalyticsOverview } from "@/lib/types";

import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  CircleDollarSign,
  FlaskConical,
  Mail,
  MessageCircle,
  Send,
  ShieldCheck,
  ShieldOff,
  Users,
} from "lucide-react";

const SEGMENT_BAR_COLORS: Record<string, string> = {
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  teal: "bg-teal-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
  orange: "bg-orange-500",
  lime: "bg-lime-500",
};

export function AnalyticsView() {
  const { data, isLoading } = useQuery({
    queryKey: ["analytics-overview"],
    queryFn: () => api.get<AnalyticsOverview>("/api/analytics/overview"),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Analytics unavailable"
        description="Please refresh the page."
      />
    );
  }

  const s = data.stats;
  const maxSegment = Math.max(1, ...data.segmentSizes.map((x) => x.count));

  return (
    <div className="space-y-8">
      {data.providerMode.mode === "SIMULATION" && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
          <FlaskConical className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Simulation mode</p>
            <p className="mt-0.5 leading-relaxed">
              Sent counts come from real pipeline runs. Delivered / opened / clicked fill up only
              when a live provider reports webhook events — nothing is estimated or invented.
            </p>
          </div>
        </div>
      )}

      {/* Funnel */}
      <div>
        <SectionHeading
          title="Campaign performance"
          description="Across every campaign you have ever sent."
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricTile label="Messages sent" value={s.sent} icon={Send} />
          <MetricTile
            label="Delivered"
            value={s.delivered}
            icon={Mail}
            hint={pct(s.deliveryRate)}
          />
          <MetricTile label="Opened" value={s.opened} icon={MessageCircle} hint={pct(s.openRate)} />
          <MetricTile
            label="Clicked"
            value={s.clicked}
            icon={MessageCircle}
            hint={pct(s.clickRate)}
          />
          <MetricTile label="Bookings" value={s.bookings} icon={Users} />
          <MetricTile
            label="Revenue attributed"
            value={s.revenue}
            icon={CircleDollarSign}
            prefix="₹"
          />
          <MetricTile
            label="ROI"
            value={s.roi != null ? `${s.roi.toFixed(1)}x` : "—"}
            icon={CircleDollarSign}
            hint={
              s.estimatedCost > 0
                ? `est. cost ₹${formatNumber(s.estimatedCost)}`
                : "send a campaign first"
            }
          />
          <MetricTile
            label="Skipped (no consent)"
            value={s.skipped}
            icon={ShieldOff}
            hint="consent engine working"
          />
        </div>
      </div>

      {/* Top campaigns */}
      <div>
        <SectionHeading
          title="Top campaigns"
          description="Ranked by attributed revenue, then by sends."
        />
        {data.topCampaigns.length === 0 ? (
          <EmptyState
            icon={Send}
            title="No campaign data yet"
            description="Create and send a campaign — its performance will show up here."
          />
        ) : (
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="divide-y">
              {data.topCampaigns.map((c, i) => (
                <div key={c.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span className="text-sm font-bold text-muted-foreground w-5">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(c.sent)} sent · {c.bookings} booking
                      {c.bookings === 1 ? "" : "s"}
                    </p>
                  </div>
                  <p className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    ₹{formatNumber(c.revenue)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Segment sizes */}
      <div>
        <SectionHeading
          title="Guest segments"
          description="How your guest book is distributed today."
        />
        <div className="rounded-xl border bg-card p-5 space-y-3">
          {data.segmentSizes.map((seg) => (
            <div key={seg.name} className="flex items-center gap-3">
              <p className="w-36 shrink-0 text-sm truncate">{seg.name}</p>
              <div className="flex-1 h-2.5 rounded-full bg-accent overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    SEGMENT_BAR_COLORS[seg.color ?? ""] ?? "bg-primary",
                  )}
                  style={{ width: `${Math.max(2, (seg.count / maxSegment) * 100)}%` }}
                />
              </div>
              <p className="w-10 text-right text-sm font-semibold tabular-nums">{seg.count}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Consent health */}
      <div>
        <SectionHeading
          title="Consent health"
          description="Reachable guests vs. opted-out — campaigns respect this automatically."
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ConsentTile
            icon={ShieldCheck}
            tone="emerald"
            label="Marketing opt-in"
            value={data.consent.optedIn}
            total={data.consent.totalCustomers}
            desc="Guests who agreed to receive offers"
          />
          <ConsentTile
            icon={ShieldOff}
            tone="rose"
            label="Opted out"
            value={data.consent.optedOut}
            total={data.consent.totalCustomers}
            desc="Will never receive campaigns"
          />
          <ConsentTile
            icon={Users}
            tone="muted"
            label="No consent yet"
            value={data.consent.unreachable}
            total={data.consent.totalCustomers}
            desc="Ask at reception to grow reach"
          />
        </div>
      </div>
    </div>
  );
}

function pct(v: number | null): string | undefined {
  return v != null ? `${Math.round(v * 100)}% rate` : undefined;
}

function MetricTile({
  label,
  value,
  icon: Icon,
  prefix,
  hint,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  prefix?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-[26px] font-bold tabular-nums leading-none">
        {prefix}
        {typeof value === "number" ? formatNumber(value) : value}
      </p>
      {hint && <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ConsentTile({
  icon: Icon,
  tone,
  label,
  value,
  total,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "emerald" | "rose" | "muted";
  label: string;
  value: number;
  total: number;
  desc: string;
}) {
  const tones = {
    emerald: "bg-emerald-500/12 text-emerald-600",
    rose: "bg-rose-500/12 text-rose-600",
    muted: "bg-primary/10 text-primary",
  };
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", tones[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[12.5px] text-muted-foreground">{label}</p>
          <p className="text-xl font-bold tabular-nums">
            {formatNumber(value)}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              ({total > 0 ? Math.round((value / total) * 100) : 0}%)
            </span>
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{desc}</p>
    </div>
  );
}
