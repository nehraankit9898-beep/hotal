"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { SegmentDetailResponse, SegmentRow, SegmentsResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDate, formatNumber, maskPhoneDisplay } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  XCircle,
  Zap,
} from "lucide-react";

const SEGMENT_ICONS: Record<string, string> = {
  new_customer: "🌱",
  returning: "🔁",
  vip: "👑",
  inactive: "💤",
  recent: "🕒",
  birthday: "🎂",
  anniversary: "💕",
  weekend: "🎉",
  high_value: "💎",
};

function ruleText(segment: SegmentRow): string {
  if (segment.type === "MANUAL") return "Hand-picked guests";
  switch (segment.rule?.kind) {
    case "new_customer":
      return "Exactly 1 stay";
    case "returning":
      return "2+ stays";
    case "vip":
      return `VIP flag or spend ≥ ₹${formatNumber(segment.rule.params?.minSpend ?? 0)}`;
    case "inactive":
      return `No visit in ${segment.rule.params?.days ?? 90}+ days`;
    case "recent":
      return "Visited 7–30 days ago";
    case "birthday":
      return `Birthday in next ${segment.rule.params?.days ?? 14} days`;
    case "anniversary":
      return `Anniversary in next ${segment.rule.params?.days ?? 14} days`;
    case "weekend":
      return "Mostly weekend stays";
    case "high_value":
      return `Lifetime spend ≥ ₹${formatNumber(segment.rule.params?.minSpend ?? 0)}`;
    default:
      return "Automatic rule";
  }
}

export function SegmentsView({ onOpenCustomer }: { onOpenCustomer: (id: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["segments"],
    queryFn: () => api.get<SegmentsResponse>("/api/segments"),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.put("/api/segments", {}),
    onSuccess: (res: unknown) => {
      const total = (res as { refreshed?: { memberCount: number }[] }).refreshed?.reduce(
        (s, r) => s + r.memberCount,
        0,
      );
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      toast({
        title: "Segments refreshed",
        description: `${total ?? 0} member assignments updated across all automatic segments.`,
      });
    },
    onError: (err) =>
      toast({
        title: "Could not refresh",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post("/api/segments", { name: newName.trim(), description: newDesc.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      toast({
        title: "Segment created",
        description: `"${newName.trim()}" is ready. Add guests to it from any customer.`,
      });
      setCreateOpen(false);
      setNewName("");
      setNewDesc("");
    },
    onError: (err) => {
      setAddError(err instanceof ApiError ? err.message : "Segment could not be created.");
    },
  });

  const segments = data?.segments ?? [];
  const autoSegments = segments.filter((s) => s.type === "AUTO");
  const manualSegments = segments.filter((s) => s.type === "MANUAL");

  if (selectedId) {
    return (
      <SegmentDetail
        segmentId={selectedId}
        onBack={() => setSelectedId(null)}
        onOpenCustomer={onOpenCustomer}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setCreateOpen(true)}>
          <UsersRound className="h-4 w-4" /> New Manual Segment
        </Button>
        <Button
          variant="outline"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh Automatic Segments
        </Button>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Automatic segments re-evaluate every guest against live stay data.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No segments yet"
          description="Automatic segments appear here once created. Click refresh to build them now."
          action={
            <Button onClick={() => refreshMutation.mutate()}>
              <RefreshCw className="h-4 w-4" /> Refresh Now
            </Button>
          }
        />
      ) : (
        <>
          {/* Automatic segments */}
          <div>
            <SectionHeading
              title="Automatic segments"
              description="Recomputed from stay data, spend, dates and VIP flags — always up to date."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {autoSegments.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className="text-left rounded-xl border bg-card p-5 hover:shadow-md hover:border-primary/40 transition-all focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-[15px] tracking-tight flex items-center gap-2">
                        <span aria-hidden>{SEGMENT_ICONS[s.rule?.kind ?? ""] ?? "✨"}</span>
                        {s.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                        {s.description}
                      </p>
                      <p className="mt-2 text-[11px] font-medium text-primary/80">{ruleText(s)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[26px] font-bold tabular-nums leading-none">
                        {formatNumber(s.memberCount)}
                      </p>
                      <p className="text-[10.5px] text-muted-foreground mt-1">guests</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Manual segments */}
          <div>
            <SectionHeading
              title="Manual segments"
              description="Custom groups you curate yourself — perfect for personal campaigns."
              action={
                manualSegments.length === 0 ? (
                  <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                    Create your first
                  </Button>
                ) : undefined
              }
            />
            {manualSegments.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-card/50 px-6 py-8 text-center text-sm text-muted-foreground">
                No manual segments yet. Create one to group guests your way.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {manualSegments.map((s) => (
                  <ManualSegmentCard key={s.id} segment={s} onOpen={() => setSelectedId(s.id)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a manual segment</DialogTitle>
            <DialogDescription>
              Group guests yourself — e.g. &quot;Diwali VIP list&quot; or &quot;Corporate
              contacts&quot;.
            </DialogDescription>
          </DialogHeader>
          {addError && <p className="text-sm text-destructive">{addError}</p>}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="seg-name">Segment name *</Label>
              <Input
                id="seg-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Diwali VIP list"
                maxLength={60}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seg-desc">Description (optional)</Label>
              <Textarea
                id="seg-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What is this group for?"
                rows={2}
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setAddError(null);
                createMutation.mutate();
              }}
              disabled={createMutation.isPending || newName.trim().length < 2}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create segment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ManualSegmentCard({ segment, onOpen }: { segment: SegmentRow; onOpen: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/segments/${segment.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      toast({ title: "Segment deleted", description: `"${segment.name}" was removed.` });
      setConfirmOpen(false);
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast({
        title: "Could not delete",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onOpen} className="text-left min-w-0 focus:outline-none">
            <p className="font-semibold text-[15px] tracking-tight truncate">{segment.name}</p>
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {segment.description ?? "No description"}
            </p>
            <p className="mt-2 text-[11px] font-medium text-primary/80">
              {formatNumber(segment.memberCount)} guest{segment.memberCount === 1 ? "" : "s"}
            </p>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${segment.name}`}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{segment.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              The group will be removed for everyone. Guests themselves are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                deleteMutation.mutate();
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function SegmentDetail({
  segmentId,
  onBack,
  onOpenCustomer,
}: {
  segmentId: string;
  onBack: () => void;
  onOpenCustomer: (id: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["segment", segmentId],
    queryFn: () => api.get<SegmentDetailResponse>(`/api/segments/${segmentId}`),
  });

  const members = useMemo(() => data?.members ?? [], [data]);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md px-1"
      >
        <ArrowLeft className="h-4 w-4" /> All segments
      </button>

      {isLoading ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : !data ? (
        <EmptyState
          icon={UsersRound}
          title="Segment not found"
          description="It may have been deleted."
        />
      ) : (
        <>
          <div className="rounded-xl border bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold tracking-tight">{data.segment.name}</h2>
                  <Badge variant={data.segment.type === "AUTO" ? "default" : "secondary"}>
                    {data.segment.type === "AUTO" ? "Automatic" : "Manual"}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {data.segment.description ?? ruleText(data.segment)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold tabular-nums leading-none">
                  {formatNumber(members.length)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">guests in this segment</p>
              </div>
            </div>
          </div>

          {members.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="No guests match yet"
              description="As guests stay, spend and share details, they will appear here automatically."
            />
          ) : (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="max-h-[480px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Guest</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead className="text-right">Stays</TableHead>
                      <TableHead className="text-right">Lifetime spend</TableHead>
                      <TableHead>Last visit</TableHead>
                      <TableHead>Campaign eligible</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m) => (
                      <TableRow
                        key={m.id}
                        className="cursor-pointer hover:bg-accent/40"
                        onClick={() => onOpenCustomer(m.id)}
                      >
                        <TableCell>
                          <span className="font-medium flex items-center gap-1.5">
                            {m.name}
                            {m.vip && (
                              <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-0 px-1.5 py-0 text-[10px]">
                                VIP
                              </Badge>
                            )}
                          </span>
                          {m.email && <p className="text-xs text-muted-foreground">{m.email}</p>}
                        </TableCell>
                        <TableCell className="text-sm">{maskPhoneDisplay(m.phone)}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.totalVisits}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.totalSpend > 0 ? `₹${formatNumber(m.totalSpend)}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(m.lastVisitAt)}</TableCell>
                        <TableCell>
                          {m.campaignEligible ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Yes
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                              <XCircle className="h-3.5 w-3.5" /> No consent / inactive
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <p className={cn("text-xs text-muted-foreground flex items-center gap-1.5")}>
            <Zap className="h-3.5 w-3.5 text-primary" />
            Tip: campaigns target a segment — pick this one in the campaign builder.
          </p>
        </>
      )}
    </div>
  );
}
