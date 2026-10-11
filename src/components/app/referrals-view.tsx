"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Users } from "lucide-react";

interface ReferralData {
  program: {
    id: string;
    active: boolean;
    referrerRewardType: string;
    referrerRewardValue: number;
    refereeRewardType: string;
    refereeRewardValue: number;
    minSpendMinor: number | null;
    maxRewardsPerReferrer: number | null;
  };
  stats: { totalCodes: number };
  referrals: {
    id: string;
    status: string;
    referrer: { name: string };
    referee: { name: string };
    rewardedAt: string | null;
    rejectReason: string | null;
    createdAt: string;
  }[];
}

const TONE: Record<string, string> = {
  PENDING: "bg-amber-500 hover:bg-amber-500",
  QUALIFIED: "bg-blue-600 hover:bg-blue-600",
  REWARDED: "bg-emerald-600 hover:bg-emerald-600",
  REJECTED: "bg-red-700 hover:bg-red-700",
};

/** Phase 15 — referral program configuration + records. */
export function ReferralsView() {
  const queryClient = useQueryClient();
  const [referrerPts, setReferrerPts] = useState("100");
  const [refereePts, setRefereePts] = useState("100");

  const dataQ = useQuery({
    queryKey: ["referrals"],
    queryFn: async () => (await api.get("/api/referrals")) as ReferralData,
  });

  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => (await api.put("/api/referrals", patch)) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Referral program updated.");
      queryClient.invalidateQueries({ queryKey: ["referrals"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const program = dataQ.data?.program;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Referral program"
        description="Both-side rewards after the referee's first qualifying paid bill. Self-referrals, duplicates and cap abuse are blocked server-side."
      />
      {program && (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={program.active}
                onCheckedChange={(v) => save.mutate({ active: v })}
                aria-label="Toggle referral program"
              />
              <span className="text-sm">{program.active ? "Active" : "Paused"}</span>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Referrer points</label>
              <Input className="w-24" type="number" value={referrerPts} onChange={(e) => setReferrerPts(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Referee points</label>
              <Input className="w-24" type="number" value={refereePts} onChange={(e) => setRefereePts(e.target.value)} />
            </div>
            <Button
              onClick={() => save.mutate({ referrerRewardValue: Number(referrerPts), refereeRewardValue: Number(refereePts) })}
              disabled={save.isPending}
            >
              Save rewards
            </Button>
            <span className="text-xs text-muted-foreground">{dataQ.data?.stats.totalCodes ?? 0} shareable codes issued</span>
          </CardContent>
        </Card>
      )}

      {(dataQ.data?.referrals ?? []).length === 0 ? (
        <EmptyState icon={Users} title="No referrals yet" description="Generate a customer's code from their profile, then attribute a friend via the code." />
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {(dataQ.data?.referrals ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="p-3 flex items-center gap-3 text-sm">
                <span className="flex-1">{r.referrer.name} → {r.referee.name}</span>
                <Badge className={TONE[r.status] ?? ""}>{r.status}</Badge>
                {r.rejectReason && <span className="text-xs text-red-600">{r.rejectReason}</span>}
                {r.rewardedAt && <span className="text-xs text-muted-foreground">rewarded {new Date(r.rewardedAt).toLocaleDateString()}</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
