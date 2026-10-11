"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionHeading, EmptyState } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { Route, Plus, Loader2, Trash2, CalendarClock, MessageSquareText, Tag } from "lucide-react";

interface JourneyStepRow {
  id: string;
  offsetDays: number;
  label: string;
  messageTemplate: string;
  channels: string;
  offer: string | null;
  couponId: string | null;
  sortOrder: number;
  enabled: boolean;
}

interface JourneyRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  steps: JourneyStepRow[];
}

function parseChannels(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
};

export function JourneysView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["journeys"],
    queryFn: () => api.get<{ journeys: JourneyRow[] }>("/api/journeys"),
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      name: string;
      description: string;
      enabled: boolean;
      steps: { offsetDays: number; label: string; messageTemplate: string; channels: string[] }[];
    }) => api.post("/api/journeys", body),
    onSuccess: () => {
      toast({ title: "Journey created", description: "The follow-up day plan is ready to use." });
      qc.invalidateQueries({ queryKey: ["journeys"] });
      setShowCreate(false);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not create journey",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const journeys = data?.journeys ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Customer Journeys"
        description="Automated follow-up day plans — e.g. day 0 thank-you, day 3 feedback, day 7 win-back offer."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New journey
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : journeys.length === 0 ? (
        <EmptyState
          icon={Route}
          title="No journeys yet"
          description="A journey is a timed sequence of follow-ups after a visit. Create one to keep guests coming back without manual work."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Create your first journey
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {journeys.map((j) => (
            <Card key={j.id} className={!j.enabled ? "opacity-70" : ""}>
              <CardContent className="p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Route className="h-[18px] w-[18px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14.5px] font-bold">{j.name}</h3>
                      <Badge variant={j.enabled ? "secondary" : "outline"} className="text-[10px]">
                        {j.enabled ? "Active" : "Paused"}
                      </Badge>
                    </div>
                    {j.description && (
                      <p className="mt-1 text-[12.5px] text-muted-foreground">{j.description}</p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      Created {formatDate(j.createdAt)}
                    </p>

                    {/* Steps timeline */}
                    <div className="mt-4 space-y-2.5 border-l-2 border-primary/25 pl-4">
                      {j.steps.map((s) => (
                        <div key={s.id} className="relative">
                          <span className="absolute -left-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/10" />
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="gap-1 text-[10.5px] font-mono">
                              <CalendarClock className="h-3 w-3" /> Day {s.offsetDays}
                            </Badge>
                            <span className="text-[12.5px] font-semibold">{s.label}</span>
                            {parseChannels(s.channels).map((c) => (
                              <Badge key={c} variant="secondary" className="text-[9.5px] px-1.5">
                                {CHANNEL_LABELS[c] ?? c}
                              </Badge>
                            ))}
                            {s.offer && (
                              <Badge className="gap-1 border-0 bg-amber-500/12 text-amber-600 text-[9.5px] px-1.5">
                                <Tag className="h-3 w-3" /> {s.offer}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
                            <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0" />
                            {s.messageTemplate}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateJourneyDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        loading={createMutation.isPending}
        onSubmit={(body) => createMutation.mutate(body)}
      />
    </div>
  );
}

interface DraftStep {
  offsetDays: number;
  label: string;
  messageTemplate: string;
  channels: string[];
}

function CreateJourneyDialog({
  open,
  onOpenChange,
  loading,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loading: boolean;
  onSubmit: (body: {
    name: string;
    description: string;
    enabled: boolean;
    steps: DraftStep[];
  }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [steps, setSteps] = useState<DraftStep[]>([
    {
      offsetDays: 0,
      label: "Thank-you message",
      messageTemplate: "Thank you for staying with us, {{name}}! We hope to see you again soon.",
      channels: ["WHATSAPP"],
    },
    {
      offsetDays: 3,
      label: "Feedback request",
      messageTemplate: "Hi {{name}}, how was your stay? We would love a quick review.",
      channels: ["SMS"],
    },
  ]);

  function addStep() {
    const maxOffset = steps.length ? Math.max(...steps.map((s) => s.offsetDays)) : 0;
    setSteps((s) => [
      ...s,
      { offsetDays: maxOffset + 3, label: "", messageTemplate: "", channels: ["WHATSAPP"] },
    ]);
  }

  function removeStep(idx: number) {
    setSteps((s) => s.filter((_, i) => i !== idx));
  }

  function updateStep(idx: number, patch: Partial<DraftStep>) {
    setSteps((s) => s.map((st, i) => (i === idx ? { ...st, ...patch } : st)));
  }

  const valid =
    name.trim().length >= 3 &&
    steps.length > 0 &&
    steps.every(
      (s) =>
        s.label.trim() &&
        s.messageTemplate.trim() &&
        Number.isFinite(s.offsetDays) &&
        s.offsetDays >= 0,
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New customer journey</DialogTitle>
          <DialogDescription>
            Define a timed sequence of follow-ups sent after a visit. Available personalisation:{" "}
            {"{{name}}"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Journey name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Post-stay win-back"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="3-touch follow-up after checkout"
                maxLength={140}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-[13px] font-medium">Active</p>
              <p className="text-[11.5px] text-muted-foreground">
                Inactive journeys are saved but never send.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Toggle journey active"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Steps ({steps.length})</Label>
              <Button type="button" variant="outline" size="sm" onClick={addStep}>
                <Plus className="h-3.5 w-3.5" /> Add step
              </Button>
            </div>
            {steps.map((s, idx) => (
              <div key={idx} className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-[92px] space-y-1">
                    <Label className="text-[11px]">Day offset</Label>
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      value={s.offsetDays}
                      onChange={(e) =>
                        updateStep(idx, {
                          offsetDays: Math.max(0, parseInt(e.target.value, 10) || 0),
                        })
                      }
                    />
                  </div>
                  <div className="flex-1 min-w-[140px] space-y-1">
                    <Label className="text-[11px]">Label</Label>
                    <Input
                      value={s.label}
                      onChange={(e) => updateStep(idx, { label: e.target.value })}
                      placeholder="Feedback request"
                      maxLength={80}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Channels</Label>
                    <div className="flex gap-1.5">
                      {["WHATSAPP", "SMS", "EMAIL"].map((c) => {
                        const active = s.channels.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() =>
                              updateStep(idx, {
                                channels: active
                                  ? s.channels.filter((x) => x !== c)
                                  : [...s.channels, c],
                              })
                            }
                            className={`rounded-md border px-2 py-1.5 text-[10.5px] font-semibold transition-colors ${
                              active
                                ? "border-primary bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-accent"
                            }`}
                            aria-pressed={active}
                          >
                            {CHANNEL_LABELS[c]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {steps.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive"
                      aria-label={`Remove step ${idx + 1}`}
                      onClick={() => removeStep(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Message</Label>
                  <Textarea
                    value={s.messageTemplate}
                    onChange={(e) => updateStep(idx, { messageTemplate: e.target.value })}
                    placeholder="Hi {{name}}, thank you for staying with us!"
                    className="min-h-[60px] text-[12.5px]"
                    maxLength={500}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || loading}
            onClick={() =>
              onSubmit({ name: name.trim(), description: description.trim(), enabled, steps })
            }
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
            Create journey
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
