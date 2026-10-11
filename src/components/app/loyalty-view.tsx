"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { LoyaltyResponse, LoyaltyTxnRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDateTime, formatNumber, maskPhoneDisplay } from "@/lib/format";
import { Gift, Plus, Loader2, Settings2, History, Minus, Award } from "lucide-react";

/** Tier badge colors — matches the public tier rules. */
function TierBadge({ tier }: { tier: string }) {
  const map: Record<string, string> = {
    VIP: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800",
    GOLD: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-800",
    SILVER:
      "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    BRONZE:
      "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800",
  };
  return (
    <Badge variant="outline" className={map[tier] ?? map.BRONZE}>
      {tier}
    </Badge>
  );
}

export function LoyaltyView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [showSettings, setShowSettings] = useState(false);
  const [historyOf, setHistoryOf] = useState<LoyaltyResponse["accounts"][number] | null>(null);
  const [adjustOf, setAdjustOf] = useState<LoyaltyResponse["accounts"][number] | null>(null);
  const [redeemOf, setRedeemOf] = useState<LoyaltyResponse["accounts"][number] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["loyalty", page, search, tierFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "10" });
      if (search) params.set("search", search);
      if (tierFilter !== "all") params.set("tier", tierFilter);
      return api.get<LoyaltyResponse>(`/api/loyalty?${params.toString()}`);
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/loyalty", body),
    onSuccess: () => {
      toast({ title: "Loyalty settings saved" });
      qc.invalidateQueries({ queryKey: ["loyalty"] });
      setShowSettings(false);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not save settings",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const redeemMutation = useMutation({
    mutationFn: (customerId: string) =>
      api.post<{ rewardValue: number; balance: number }>("/api/loyalty/redeem", { customerId }),
    onSuccess: (res) => {
      toast({
        title: `Reward redeemed — ₹${res.rewardValue}`,
        description: `Remaining balance: ${res.balance} points.`,
      });
      qc.invalidateQueries({ queryKey: ["loyalty"] });
      setRedeemOf(null);
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not redeem",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const stats = data?.stats;
  const accounts = data?.accounts ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Loyalty Program"
        description="Customers earn points on every restaurant visit — they redeem for real rewards."
        action={
          <div className="flex gap-2">
            {data ? (
              <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs">
                <span
                  className={
                    data.settings.enabled
                      ? "text-emerald-600 font-semibold"
                      : "text-muted-foreground font-semibold"
                  }
                >
                  {data.settings.enabled ? "Program ON" : "Program OFF"}
                </span>
              </div>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
              <Settings2 className="h-4 w-4 mr-1.5" /> Rules
            </Button>
          </div>
        }
      />

      {/* Program stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] rounded-xl" />
          ))
        ) : (
          <>
            <StatCard
              title="Loyalty members"
              value={stats.members}
              hint="Customers with a points account"
              icon={Gift}
            />
            <StatCard
              title="Points outstanding"
              value={stats.totalPointsOutstanding}
              hint="Unredeemed points right now"
              icon={Award}
              tone="amber"
              delay={0.05}
            />
            <StatCard
              title="Loyalty lifetime spend"
              value={formatCurrency(stats.totalLifetimeSpend)}
              hint="Spend captured via loyalty visits"
              icon={History}
              tone="emerald"
              delay={0.1}
            />
            <StatCard
              title="Gold + VIP members"
              value={(stats.tierCounts.GOLD ?? 0) + (stats.tierCounts.VIP ?? 0)}
              hint="Your most valuable loyalists"
              icon={Award}
              tone="violet"
              delay={0.15}
            />
          </>
        )}
      </div>

      {/* Members table */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Input
              placeholder="Search by name or phone…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="sm:max-w-xs"
            />
            <Select
              value={tierFilter}
              onValueChange={(v) => {
                setTierFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="sm:w-40">
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tiers</SelectItem>
                <SelectItem value="BRONZE">Bronze</SelectItem>
                <SelectItem value="SILVER">Silver</SelectItem>
                <SelectItem value="GOLD">Gold</SelectItem>
                <SelectItem value="VIP">VIP</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState
              icon={Gift}
              title="No loyalty members yet"
              description="Members appear here automatically when customers join from your QR page or when a restaurant visit earns points."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead className="text-right">Points</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Lifetime spend
                      </TableHead>
                      <TableHead className="text-right hidden md:table-cell">Visits</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <p className="font-medium">{a.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {maskPhoneDisplay(a.phone)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <TierBadge tier={a.tier} />
                        </TableCell>
                        <TableCell className="text-right font-bold tabular-nums text-primary">
                          {formatNumber(a.points)}
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell tabular-nums">
                          {formatCurrency(a.lifetimeSpend)}
                        </TableCell>
                        <TableCell className="text-right hidden md:table-cell tabular-nums">
                          {a.visitsCounted}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setHistoryOf(a)}
                              title="History"
                            >
                              <History className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setAdjustOf(a)}
                              title="Adjust points"
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setRedeemOf(a)}
                              disabled={a.points < (data?.settings.pointsForReward ?? Infinity)}
                            >
                              Redeem
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {data && data.totalPages > 1 ? (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <p className="text-muted-foreground">
                    Page {data.page} of {data.totalPages} · {data.total} members
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
        </CardContent>
      </Card>

      {data ? (
        <>
          <SettingsDialog
            open={showSettings}
            onClose={() => setShowSettings(false)}
            settings={data.settings}
            saving={settingsMutation.isPending}
            onSave={(body) => settingsMutation.mutate(body)}
          />
          <HistoryDialog account={historyOf} onClose={() => setHistoryOf(null)} />
          <AdjustDialog account={adjustOf} onClose={() => setAdjustOf(null)} />
          <Dialog open={!!redeemOf} onOpenChange={(o) => !o && setRedeemOf(null)}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Redeem reward?</DialogTitle>
                <DialogDescription>
                  {redeemOf?.name} will exchange {data.settings.pointsForReward} points for a ₹
                  {data.settings.rewardValue} reward. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRedeemOf(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={redeemMutation.isPending}
                  onClick={() => redeemOf && redeemMutation.mutate(redeemOf.customerId)}
                >
                  {redeemMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Redeem ₹{data.settings.rewardValue}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

function SettingsDialog({
  open,
  onClose,
  settings,
  saving,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  settings: LoyaltyResponse["settings"];
  saving: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [mode, setMode] = useState(settings.mode);
  const [pointsPer100, setPointsPer100] = useState(String(settings.pointsPer100));
  const [pointsPerVisit, setPointsPerVisit] = useState(String(settings.pointsPerVisit));
  const [pointsForReward, setPointsForReward] = useState(String(settings.pointsForReward));
  const [rewardValue, setRewardValue] = useState(String(settings.rewardValue));
  const [signupBonus, setSignupBonus] = useState(String(settings.signupBonus));
  const [silver, setSilver] = useState(String(settings.silverTierSpend));
  const [gold, setGold] = useState(String(settings.goldTierSpend));
  const [vip, setVip] = useState(String(settings.vipTierSpend));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Loyalty rules</DialogTitle>
          <DialogDescription>
            How customers earn points and what their points are worth. Changes apply to future
            visits.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Program enabled</p>
              <p className="text-xs text-muted-foreground">When off, visits stop earning points.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div>
            <Label>Earning mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "POINTS" | "VISITS")}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="POINTS">By spend — points per ₹100 spent</SelectItem>
                <SelectItem value="VISITS">By visit — flat points per visit</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "POINTS" ? (
            <div>
              <Label htmlFor="ly-p100">Points per ₹100 spent</Label>
              <Input
                id="ly-p100"
                type="number"
                min={0}
                max={1000}
                value={pointsPer100}
                onChange={(e) => setPointsPer100(e.target.value)}
                className="mt-1"
              />
            </div>
          ) : (
            <div>
              <Label htmlFor="ly-pv">Points per visit</Label>
              <Input
                id="ly-pv"
                type="number"
                min={0}
                max={10000}
                value={pointsPerVisit}
                onChange={(e) => setPointsPerVisit(e.target.value)}
                className="mt-1"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ly-pfr">Points for a reward</Label>
              <Input
                id="ly-pfr"
                type="number"
                min={1}
                value={pointsForReward}
                onChange={(e) => setPointsForReward(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="ly-rv">Reward value (₹)</Label>
              <Input
                id="ly-rv"
                type="number"
                min={0}
                value={rewardValue}
                onChange={(e) => setRewardValue(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="ly-bonus">Welcome bonus points (on join)</Label>
            <Input
              id="ly-bonus"
              type="number"
              min={0}
              max={10000}
              value={signupBonus}
              onChange={(e) => setSignupBonus(e.target.value)}
              className="mt-1"
            />
          </div>

          <div className="rounded-lg border p-3">
            <p className="text-sm font-medium mb-2">Tier thresholds (lifetime restaurant spend)</p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Silver ₹</Label>
                <Input
                  type="number"
                  min={0}
                  value={silver}
                  onChange={(e) => setSilver(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Gold ₹</Label>
                <Input
                  type="number"
                  min={0}
                  value={gold}
                  onChange={(e) => setGold(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">VIP ₹</Label>
                <Input
                  type="number"
                  min={0}
                  value={vip}
                  onChange={(e) => setVip(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              onSave({
                enabled,
                mode,
                pointsPer100: Number(pointsPer100),
                pointsPerVisit: Number(pointsPerVisit),
                pointsForReward: Number(pointsForReward),
                rewardValue: Number(rewardValue),
                signupBonus: Number(signupBonus),
                silverTierSpend: Number(silver),
                goldTierSpend: Number(gold),
                vipTierSpend: Number(vip),
              })
            }
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TXN_TYPE_LABELS: Record<string, string> = {
  EARN: "Earned",
  EARN_VISIT: "Visit earned",
  REDEEM: "Redeemed",
  ADJUST: "Adjusted",
  SIGNUP_BONUS: "Welcome bonus",
  REVERSAL: "Visit reversal",
  VISIT_ADJUST: "Visit correction",
};

function HistoryDialog({
  account,
  onClose,
}: {
  account: LoyaltyResponse["accounts"][number] | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["loyalty-txns", account?.customerId],
    queryFn: () =>
      api.get<{ transactions: LoyaltyTxnRow[] }>(
        `/api/loyalty/transactions?customerId=${account!.customerId}&pageSize=15`,
      ),
    enabled: !!account,
  });

  // Phase 6.4 — reconcile diagnostic (ledger total vs stored balance, optional repair)
  const reconcileMutation = useMutation({
    mutationFn: (repair: boolean) =>
      api.post<{
        report: { ledgerTotal: number; storedBalance: number; drift: number; matched: boolean };
      }>("/api/loyalty/reconcile", { customerId: account!.customerId, repair }),
    onSuccess: (res) => {
      const r = res.report;
      toast({
        title: r.matched ? "Points are consistent" : "Mismatch detected",
        description: r.matched
          ? `Ledger total ${r.ledgerTotal} matches the stored balance.`
          : `Ledger ${r.ledgerTotal} vs stored ${r.storedBalance} (drift ${r.drift > 0 ? "+" : ""}${r.drift}).` +
            (r.drift === 0 ? " Repaired." : ""),
      });
      qc.invalidateQueries({ queryKey: ["loyalty"] });
      qc.invalidateQueries({ queryKey: ["loyalty-txns", account?.customerId] });
    },
    onError: (err: unknown) =>
      toast({
        title: "Reconciliation failed",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={!!account} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Points history — {account?.name}</DialogTitle>
          <DialogDescription>
            Every earn, redemption, adjustment and reversal is recorded here.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-2">
          {isLoading ? (
            <Skeleton className="h-24" />
          ) : (data?.transactions.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            data!.transactions.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {TXN_TYPE_LABELS[t.type] ?? t.type.replace(/_/g, " ")}
                    {t.reason ? ` · ${t.reason}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(t.createdAt)}</p>
                </div>
                <div className="text-right">
                  <p
                    className={`text-sm font-bold tabular-nums ${t.points >= 0 ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {t.points >= 0 ? "+" : ""}
                    {t.points}
                  </p>
                  <p className="text-[11px] text-muted-foreground">bal {t.balanceAfter}</p>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">Ledger vs balance check</p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={reconcileMutation.isPending || !account}
              onClick={() => reconcileMutation.mutate(false)}
              title="Compare the ledger total against the stored balance"
            >
              {reconcileMutation.isPending ? "Checking…" : "Reconcile"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-amber-600 dark:text-amber-400"
              disabled={reconcileMutation.isPending || !account}
              onClick={() => reconcileMutation.mutate(true)}
              title="Repair any drift with an audited adjustment entry"
            >
              Reconcile &amp; repair
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({
  account,
  onClose,
}: {
  account: LoyaltyResponse["accounts"][number] | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: (body: { customerId: string; points: number; reason: string }) =>
      api.post<{ balance: number }>("/api/loyalty/adjust", body),
    onSuccess: (res) => {
      toast({ title: "Points adjusted", description: `New balance: ${res.balance} points.` });
      qc.invalidateQueries({ queryKey: ["loyalty"] });
      setPoints("");
      setReason("");
      onClose();
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not adjust points",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const num = Number(points);
  const valid = Number.isInteger(num) && num !== 0 && reason.trim().length > 0;

  return (
    <Dialog open={!!account} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust points — {account?.name}</DialogTitle>
          <DialogDescription>
            Current balance: {account?.points} points. Use a negative number to deduct.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="adj-points">Points (use − to deduct)</Label>
            <Input
              id="adj-points"
              type="number"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              placeholder="e.g. 50 or -20"
            />
          </div>
          <div>
            <Label htmlFor="adj-reason">Reason (required)</Label>
            <Textarea
              id="adj-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Compensation for long wait"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || mutation.isPending}
            onClick={() =>
              account && mutation.mutate({ customerId: account.customerId, points: num, reason })
            }
          >
            {num >= 0 ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />} Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
