"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { AutomationsResponse } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import { Bot, Plus, Play, Pause, Loader2, Zap } from "lucide-react";

const TRIGGER_LABELS: Record<string, string> = {
  HOTEL_CHECKOUT: "After hotel checkout",
  RESTAURANT_VISIT: "After restaurant visit",
  INACTIVE_7: "Customer inactive 7 days",
  INACTIVE_15: "Customer inactive 15 days",
  INACTIVE_30: "Customer inactive 30 days",
  BIRTHDAY: "Customer birthday (today)",
  ANNIVERSARY: "Customer anniversary (today)",
  VIP_THRESHOLD: "Customer tagged VIP",
  OFFER_UNUSED: "Offer sent but not redeemed",
  REPEAT_VISIT: "Customer repeats a visit",
  SPECIAL_EVENT: "Special event trigger",
};

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "bg-slate-500/15 text-slate-600" },
  ACTIVE: { label: "Active", tone: "bg-emerald-500/15 text-emerald-600" },
  PAUSED: { label: "Paused", tone: "bg-amber-500/15 text-amber-600" },
  ARCHIVED: { label: "Archived", tone: "bg-slate-500/15 text-slate-600" },
  FAILED: { label: "Failed", tone: "bg-rose-500/15 text-rose-600" },
};

export function AutomationsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["automations"],
    queryFn: () => api.get<AutomationsResponse>("/api/automations"),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.put(`/api/automations/run?id=${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automations"] });
      toast({ title: "Automation updated" });
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not update",
        description: err instanceof ApiError ? err.message : "Could not update.",
        variant: "destructive",
      }),
  });

  const runNowMutation = useMutation({
    mutationFn: () => api.post<{ queued?: number }>("/api/automations/run"),
    onSuccess: (res: { queued?: number }) => {
      toast({
        title: "Automation scan complete",
        description: `Queued: ${res.queued ?? 0} · Executed today's pending runs.`,
      });
      refetch();
    },
    onError: (err: unknown) =>
      toast({
        title: "Scan failed",
        description: err instanceof ApiError ? err.message : "Scan failed.",
        variant: "destructive",
      }),
  });

  const automations = data?.automations ?? [];
  const executions = data?.recentExecutions ?? [];
  const todayCount = data?.stats.totalExecutionsToday ?? 0;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Marketing Automation"
        description="Visual workflows: trigger → wait → condition → action. Each automation sends real consent-gated messages through your connected providers."
        action={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => runNowMutation.mutate()}
              disabled={runNowMutation.isPending}
            >
              {runNowMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              Run Now
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> New Automation
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Bot className="h-3.5 w-3.5" /> Active Automations
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {automations.filter((a) => a.status === "ACTIVE").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5" /> Executions Today
            </div>
            <p className="text-2xl font-bold tabular-nums mt-1">{todayCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">Total Runs</div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {automations.reduce((s, a) => s + a.runsCount, 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">Paused</div>
            <p className="text-2xl font-bold tabular-nums mt-1">
              {automations.filter((a) => a.status === "PAUSED").length}
            </p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : automations.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No automations yet"
          description="Automations trigger real messages based on customer events. Birthday offers, win-back campaigns, and review requests — all on autopilot."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Create Automation
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Wait</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Last Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {automations.map((a) => {
                  const status = STATUS_LABELS[a.status] ?? { label: a.status, tone: "" };
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        {a.description && (
                          <div className="text-xs text-muted-foreground">{a.description}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{TRIGGER_LABELS[a.trigger] ?? a.trigger}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {a.waitDays === 0 ? "Immediate" : `+${a.waitDays} days`}
                      </TableCell>
                      <TableCell className="tabular-nums">{a.runsCount}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.lastRunAt ? formatDateTime(a.lastRunAt) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="default" className={status.tone}>
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleMutation.mutate(a.id)}
                          disabled={toggleMutation.isPending}
                        >
                          {a.status === "ACTIVE" ? (
                            <>
                              <Pause className="h-3.5 w-3.5 mr-1" />
                              Pause
                            </>
                          ) : (
                            <>
                              <Play className="h-3.5 w-3.5 mr-1" />
                              Activate
                            </>
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {executions.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="p-4 border-b">
              <h3 className="text-sm font-semibold">Recent Executions</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Last 20 automation executions across all rules.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead>Executed</TableHead>
                  <TableHead>Failure</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-sm">{e.automation.name}</TableCell>
                    <TableCell className="text-sm">{e.customer.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          e.status === "SUCCESS"
                            ? "bg-emerald-500/15 text-emerald-600"
                            : e.status === "FAILED"
                              ? "bg-rose-500/15 text-rose-600"
                              : e.status === "CANCELLED"
                                ? "bg-slate-500/15 text-slate-600"
                                : "bg-amber-500/15 text-amber-600"
                        }
                      >
                        {e.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(e.scheduledAt)}</TableCell>
                    <TableCell className="text-xs">
                      {e.executedAt ? formatDateTime(e.executedAt) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-rose-600">
                      {e.failureReason ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateAutomationDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  );
}

function CreateAutomationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState("HOTEL_CHECKOUT");
  const [waitDays, setWaitDays] = useState("1");
  const [messageTemplate, setMessageTemplate] = useState(
    "Hi {{name}}, thank you for staying at {{hotel_name}}! We hope you had a wonderful visit. 🙏",
  );
  const [offer, setOffer] = useState("");
  const [channels, setChannels] = useState<string[]>(["WHATSAPP"]);

  function toggleChannel(c: string) {
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      description: string | null;
      trigger: string;
      waitDays: number;
      conditions: { kind: string; value?: boolean }[];
      actions: { kind: string; channels: string[]; template: string }[];
      channels: string[];
      messageTemplate: string;
      offer: string | null;
    }) =>
      api.post<{ automation: AutomationsResponse["automations"][number] }>(
        "/api/automations",
        body,
      ),
    onSuccess: () => {
      toast({
        title: "Automation created",
        description:
          "It's currently in Draft status. Activate it from the list to start triggering.",
      });
      qc.invalidateQueries({ queryKey: ["automations"] });
      onOpenChange(false);
      setName("");
      setDescription("");
      setMessageTemplate(
        "Hi {{name}}, thank you for staying at {{hotel_name}}! We hope you had a wonderful visit. 🙏",
      );
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not create",
        description: err instanceof ApiError ? err.message : "Could not create.",
        variant: "destructive",
      }),
  });

  function submit() {
    createMutation.mutate({
      name,
      description,
      trigger,
      waitDays: Number(waitDays),
      conditions: [{ kind: "marketing_consent", value: true }, { kind: "no_opt_out" }],
      actions: [{ kind: "send_message", channels, template: messageTemplate }],
      channels,
      messageTemplate,
      offer: offer || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Automation Rule</DialogTitle>
          <DialogDescription>
            When the trigger fires, the action runs (after the wait, if conditions are met).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Automation Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="3-Day Thank You"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Send a thank-you message 3 days after checkout"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Trigger</Label>
              <Select value={trigger} onValueChange={setTrigger}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Wait (days)</Label>
              <Input
                type="number"
                value={waitDays}
                onChange={(e) => setWaitDays(e.target.value)}
                min={0}
                max={365}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Channels</Label>
            <div className="flex flex-wrap gap-4 pt-1">
              {["WHATSAPP", "SMS", "EMAIL"].map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <Checkbox
                    id={`ch-${c}`}
                    checked={channels.includes(c)}
                    onCheckedChange={() => toggleChannel(c)}
                  />
                  <Label htmlFor={`ch-${c}`} className="font-normal cursor-pointer">
                    {c}
                  </Label>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Message Template</Label>
            <Textarea
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              rows={4}
            />
            <p className="text-[11px] text-muted-foreground">
              Variables:{" "}
              {
                "{{name}}, {{hotel_name}}, {{last_visit}}, {{booking_count}}, {{offer}}, {{booking_link}}"
              }
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Offer (optional)</Label>
            <Input value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="20% OFF" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createMutation.isPending || name.length < 3}>
            {createMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
