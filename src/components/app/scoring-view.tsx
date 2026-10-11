"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ScoringLeaderboardEntry } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { SectionHeading, EmptyState } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { maskPhoneDisplay } from "@/lib/format";
import { Flame, RefreshCw, Loader2, Crown } from "lucide-react";

const TIER_LABELS: Record<string, string> = {
  COLD: "Cold",
  WARM: "Warm",
  HOT: "Hot",
  VERY_HOT: "Very Hot",
};

const TIER_BADGES: Record<string, string> = {
  COLD: "bg-slate-500/15 text-slate-600",
  WARM: "bg-sky-500/15 text-sky-600",
  HOT: "bg-amber-500/15 text-amber-600",
  VERY_HOT: "bg-rose-500/15 text-rose-600",
};

export function ScoringView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tier, setTier] = useState<string>("ALL");

  const { data, isLoading } = useQuery({
    queryKey: ["scoring", tier],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "25" });
      if (tier !== "ALL") params.set("tier", tier);
      return api.get<{ leaderboard: ScoringLeaderboardEntry[] }>(
        `/api/scoring?${params.toString()}`,
      );
    },
  });

  const recomputeMutation = useMutation({
    mutationFn: () => api.post<{ processed?: number }>("/api/scoring"),
    onSuccess: (res: { processed?: number }) => {
      toast({
        title: "RFM scores recomputed",
        description: `Processed ${res.processed ?? 0} customers. Lead scores refreshed from engagement signals.`,
      });
      qc.invalidateQueries({ queryKey: ["scoring"] });
    },
  });

  const leaderboard = data?.leaderboard ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Customer Intelligence & Lead Scoring"
        description="RFM scoring (Recency, Frequency, Monetary) + lead score from real engagement events. Top customers to prioritise this week."
        action={
          <div className="flex gap-2">
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Tiers</SelectItem>
                <SelectItem value="COLD">Cold (0–30)</SelectItem>
                <SelectItem value="WARM">Warm (31–60)</SelectItem>
                <SelectItem value="HOT">Hot (61–80)</SelectItem>
                <SelectItem value="VERY_HOT">Very Hot (81–100)</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
            >
              {recomputeMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Recompute Scores
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Very Hot (81+)</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-rose-600">
              {leaderboard.filter((c) => c.leadTier === "VERY_HOT").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Hot (61-80)</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-amber-600">
              {leaderboard.filter((c) => c.leadTier === "HOT").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Warm (31-60)</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-sky-600">
              {leaderboard.filter((c) => c.leadTier === "WARM").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Cold (0-30)</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-slate-600">
              {leaderboard.filter((c) => c.leadTier === "COLD").length}
            </p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : leaderboard.length === 0 ? (
        <EmptyState
          icon={Flame}
          title="No scored customers yet"
          description="Run the RFM scoring to compute customer value scores from your booking history, and lead scores from engagement events."
          action={
            <Button
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
            >
              {recomputeMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Flame className="h-4 w-4 mr-1.5" />
              )}
              Compute Scores
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>RFM</TableHead>
                  <TableHead>Value Score</TableHead>
                  <TableHead>Lead Score</TableHead>
                  <TableHead>Tier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboard.map((c, idx) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {idx === 0 && <Crown className="h-4 w-4 text-amber-500" />}
                        <span className="font-bold tabular-nums">{idx + 1}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {maskPhoneDisplay(c.phone)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2 text-xs">
                        <span>R:{c.rfm.recency}</span>
                        <span>F:{c.rfm.frequency}</span>
                        <span>M:{c.rfm.monetary}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-bold tabular-nums">{c.score}</div>
                    </TableCell>
                    <TableCell>
                      <div className="font-bold tabular-nums">{c.leadScore}</div>
                    </TableCell>
                    <TableCell>
                      <Badge className={TIER_BADGES[c.leadTier]}>{TIER_LABELS[c.leadTier]}</Badge>
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
