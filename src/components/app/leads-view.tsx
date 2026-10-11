"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { LeadEventRow, CustomersResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Label } from "@/components/ui/label";
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
import { SectionHeading, EmptyState, StatCard } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, maskPhoneDisplay } from "@/lib/format";
import {
  Flame,
  TrendingUp,
  Eye,
  MousePointerClick,
  MessageSquare,
  CheckCircle2,
  Zap,
} from "lucide-react";

const EVENT_LABELS: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  MESSAGE_OPENED: { label: "Opened", icon: Eye },
  LINK_CLICKED: { label: "Link Clicked", icon: MousePointerClick },
  OFFER_VIEWED: { label: "Offer Viewed", icon: Eye },
  REPLIED: { label: "Replied", icon: MessageSquare },
  BOOKING_PAGE_VISITED: { label: "Booking Page Visited", icon: TrendingUp },
  BOOKING_COMPLETED: { label: "Booking Completed", icon: CheckCircle2 },
  COUPON_REDEEMED: { label: "Coupon Redeemed", icon: Zap },
};

export function LeadsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [customerId, setCustomerId] = useState("");

  const { data: customersData } = useQuery({
    queryKey: ["customers-for-leads"],
    queryFn: () => api.get<CustomersResponse>("/api/customers?pageSize=50"),
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["lead-events", customerId],
    enabled: Boolean(customerId),
    queryFn: () =>
      api.get<{ events: LeadEventRow[]; currentScore: number; currentTier: string }>(
        `/api/lead-events?customerId=${customerId}`,
      ),
  });

  const recordMutation = useMutation({
    mutationFn: (body: { customerId: string; type: LeadEventRow["type"] }) =>
      api.post("/api/lead-events", body),
    onSuccess: () => {
      toast({ title: "Lead event recorded", description: "Customer score has been recomputed." });
      qc.invalidateQueries({ queryKey: ["lead-events", customerId] });
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not record event",
        description: err instanceof ApiError ? err.message : "Could not record event.",
        variant: "destructive",
      }),
  });

  const events = data?.events ?? [];
  const currentScore = data?.currentScore ?? 0;
  const currentTier = data?.currentTier ?? "COLD";

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Lead Scoring & Engagement"
        description="Each customer's engagement signals (opens, clicks, replies, bookings) contribute to a 0-100 lead score in real time."
      />

      <Card>
        <CardContent className="p-4">
          <Label className="text-xs">Select customer</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a customer to view their lead events" />
            </SelectTrigger>
            <SelectContent>
              {(customersData?.customers ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} · {maskPhoneDisplay(c.phone)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {!customerId ? (
        <EmptyState
          icon={Flame}
          title="Pick a customer"
          description="Once you select a customer, you'll see their lead score, current tier, and the recent engagement signals that contributed."
        />
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard title="Lead Score" value={currentScore} icon={Flame} tone="amber" />
            <StatCard
              title="Tier"
              value={currentTier}
              icon={TrendingUp}
              tone={
                currentTier === "VERY_HOT"
                  ? "rose"
                  : currentTier === "HOT"
                    ? "amber"
                    : currentTier === "WARM"
                      ? "violet"
                      : "default"
              }
            />
            <StatCard title="Events" value={events.length} icon={Zap} tone="emerald" />
            <StatCard
              title="Total Points"
              value={events.reduce((s, e) => s + e.points, 0)}
              icon={TrendingUp}
              tone="default"
            />
          </div>

          {events.length === 0 ? (
            <EmptyState
              icon={Eye}
              title="No engagement events yet"
              description="Once this customer opens, clicks, or replies to a campaign — or completes a booking — events will appear here and their score will increase."
              action={
                <Button
                  onClick={() =>
                    recordMutation.mutate({ customerId, type: "BOOKING_PAGE_VISITED" })
                  }
                >
                  Simulate Booking Page Visit
                </Button>
              }
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Points</TableHead>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => {
                      const meta = EVENT_LABELS[e.type] ?? { label: e.type, icon: Zap };
                      return (
                        <TableRow key={e.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <meta.icon className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm">{meta.label}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="bg-amber-500/10 text-amber-600">
                              +{e.points}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{e.campaignName ?? "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDateTime(e.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
