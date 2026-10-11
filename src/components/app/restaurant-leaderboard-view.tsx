"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { RestaurantLeaderboardEntry, SegmentRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionHeading, EmptyState } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatNumber, formatDateTime, maskPhoneDisplay } from "@/lib/format";
import { Trophy, Crown, Medal, RefreshCw, Loader2 } from "lucide-react";

export function RestaurantLeaderboardView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["restaurant-leaderboard"],
    queryFn: () =>
      api.get<{ leaderboard: RestaurantLeaderboardEntry[] }>("/api/restaurant/leaderboard"),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.put("/api/restaurant/segments/refresh"),
    onSuccess: () => {
      toast({
        title: "Segments refreshed",
        description: "All restaurant segments have been recomputed.",
      });
      qc.invalidateQueries({ queryKey: ["restaurant-leaderboard"] });
    },
  });

  const leaderboard = data?.leaderboard ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Restaurant Customer Leaderboard"
        description="Top diners by lifetime restaurant spend. Each visit, order, and redemption feeds this ranking."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            Refresh Segments
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : leaderboard.length === 0 ? (
        <EmptyState
          icon={Trophy}
          title="No restaurant customers yet"
          description="Once you start recording restaurant visits, your top diners will appear here ranked by lifetime spend."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Rank</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Visits</TableHead>
                  <TableHead>Lifetime Spend</TableHead>
                  <TableHead>Last Visit</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboard.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {c.rank === 1 && <Crown className="h-4 w-4 text-amber-500" />}
                        {c.rank === 2 && <Medal className="h-4 w-4 text-slate-400" />}
                        {c.rank === 3 && <Medal className="h-4 w-4 text-amber-700" />}
                        <span className="font-bold tabular-nums">{c.rank}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {maskPhoneDisplay(c.phone)}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatNumber(c.totalRestaurantVisits)}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {formatCurrency(c.totalRestaurantSpend)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.lastRestaurantVisit ? formatDateTime(c.lastRestaurantVisit) : "—"}
                    </TableCell>
                    <TableCell>
                      {c.vip ? (
                        <Badge variant="default" className="bg-amber-500/15 text-amber-600">
                          <Crown className="h-3 w-3 mr-1" /> VIP
                        </Badge>
                      ) : (
                        <Badge variant="outline">Standard</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-2">Restaurant Segments (Auto)</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Customers are automatically grouped into segments based on their restaurant behavior.
            Refresh to rebuild.
          </p>
          <RestaurantSegmentsCard />
        </CardContent>
      </Card>
    </div>
  );
}

function RestaurantSegmentsCard() {
  const { data } = useQuery({
    queryKey: ["restaurant-segments"],
    queryFn: () => api.get<{ segments: SegmentRow[] }>("/api/restaurant/segments"),
  });
  const segments = data?.segments ?? [];
  if (segments.length === 0) {
    return <p className="text-xs text-muted-foreground">No segments yet — record a visit first.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {segments.map((s) => (
        <Badge key={s.id} variant="outline" className="bg-primary/5">
          {s.name} · <span className="tabular-nums">{s.memberCount}</span>
        </Badge>
      ))}
    </div>
  );
}
