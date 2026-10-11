"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { FeedbackResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { formatDateTime } from "@/lib/format";
import { Star, MessageSquareHeart, TrendingUp, Users } from "lucide-react";

function StarRow({ rating }: { rating: number }) {
  return (
    <span className="text-amber-500 tracking-tight" aria-label={`${rating} out of 5 stars`}>
      {"★".repeat(rating)}
      <span className="text-muted-foreground/30">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

export function FeedbackView() {
  const [page, setPage] = useState(1);
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: "12" });
  if (ratingFilter) params.set("rating", String(ratingFilter));

  const { data, isLoading } = useQuery({
    queryKey: ["feedback", page, ratingFilter],
    queryFn: () => api.get<FeedbackResponse>(`/api/feedback?${params.toString()}`),
  });

  const stats = data?.stats;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Customer Feedback"
        description="Star ratings and comments submitted from your QR page — straight from real diners."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))
        ) : (
          <>
            <StatCard title="Total feedback" value={stats.total} icon={MessageSquareHeart} />
            <StatCard
              title="Average rating"
              value={stats.average || "—"}
              hint={stats.average ? `out of 5 stars` : "no ratings yet"}
              icon={Star}
              tone="amber"
              delay={0.05}
            />
            <StatCard
              title="Happy (4–5 ★)"
              value={(stats.distribution["4"] ?? 0) + (stats.distribution["5"] ?? 0)}
              icon={TrendingUp}
              tone="emerald"
              delay={0.1}
            />
            <StatCard
              title="Needs attention (1–2 ★)"
              value={(stats.distribution["1"] ?? 0) + (stats.distribution["2"] ?? 0)}
              icon={Users}
              tone="rose"
              delay={0.15}
            />
          </>
        )}
      </div>

      {/* Rating distribution bar */}
      {stats ? (
        <Card>
          <CardContent className="p-5">
            <p className="mb-3 text-sm font-semibold">Rating distribution</p>
            <div className="space-y-1.5">
              {[5, 4, 3, 2, 1].map((n) => {
                const count = stats.distribution[String(n)] ?? 0;
                const pct = stats.total ? Math.round((count / stats.total) * 100) : 0;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setRatingFilter(ratingFilter === n ? null : n);
                      setPage(1);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left transition hover:bg-muted ${ratingFilter === n ? "ring-1 ring-primary" : ""}`}
                  >
                    <span className="w-10 text-xs text-muted-foreground">{n} ★</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${n >= 4 ? "bg-emerald-500" : n === 3 ? "bg-amber-500" : "bg-rose-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Feedback list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (data?.feedback.length ?? 0) === 0 ? (
        <EmptyState
          icon={MessageSquareHeart}
          title={ratingFilter ? `No ${ratingFilter}-star feedback` : "No feedback yet"}
          description={
            ratingFilter
              ? "Try clearing the filter, or ask more customers to rate their experience from your table QR codes."
              : "Feedback appears here when customers scan your QR code and rate their experience. Print more QR codes for your tables."
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            {data!.feedback.map((f) => (
              <Card key={f.id}>
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StarRow rating={f.rating} />
                      {f.customer ? (
                        <Badge variant="outline" className="text-[11px]">
                          {f.customer.name}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[11px]">
                          Anonymous
                        </Badge>
                      )}
                    </div>
                    {f.comment ? (
                      <p className="mt-1.5 text-sm leading-relaxed">{f.comment}</p>
                    ) : (
                      <p className="mt-1.5 text-xs italic text-muted-foreground">No comment.</p>
                    )}
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(f.createdAt)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          {data && data.totalPages > 1 ? (
            <div className="flex items-center justify-between text-sm">
              <p className="text-muted-foreground">
                Page {data.page} of {data.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
