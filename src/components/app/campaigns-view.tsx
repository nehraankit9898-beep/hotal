"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type {
  CampaignDetailResponse,
  CampaignRow,
  CampaignsResponse,
  SendRunSummaryResponse,
  SessionUser,
  TemplatesResponse,
} from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime, formatNumber, maskPhoneDisplay } from "@/lib/format";
import {
  Bot,
  CircleDollarSign,
  FlaskConical,
  Loader2,
  Mail,
  MessageCircle,
  MousePointerClick,
  RotateCcw,
  Send,
  Smartphone,
  Users,
  Wand2,
} from "lucide-react";

const CHANNEL_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  WHATSAPP: { label: "WhatsApp", icon: MessageCircle },
  SMS: { label: "SMS", icon: Smartphone },
  EMAIL: { label: "Email", icon: Mail },
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  ACTIVE: "Active",
  COMPLETED: "Sent",
  ARCHIVED: "Archived",
};

const SKIP_REASON_LABELS: Record<string, string> = {
  NO_CONSENT: "No marketing consent",
  OPTED_OUT: "Opted out",
  INACTIVE: "Inactive customer",
  DUPLICATE: "Already received",
  RATE_LIMITED: "Daily limit reached",
  NO_EMAIL: "No email on file",
  NO_RECIPIENT: "No contact details",
  // Phase 6.4 — channel-specific consent + live pre-send check
  NO_WHATSAPP_CONSENT: "No WhatsApp opt-in",
  NO_SMS_CONSENT: "No SMS opt-in",
  NO_EMAIL_CONSENT: "No email opt-in",
  BLOCKED_CONSENT: "Consent withdrawn before send",
  FREQUENCY_LIMIT: "Too many messages recently",
};

function summarizeSend(s?: SendRunSummaryResponse["summary"] | null): string {
  if (!s) return "";
  const parts = [
    `${formatNumber(s.sent ?? 0)} sent`,
    (s.simulated ?? 0) > 0 ? `${formatNumber(s.simulated ?? 0)} simulated` : null,
    (s.skipped ?? 0) > 0 ? `${formatNumber(s.skipped)} skipped (consent/limits)` : null,
    (s.failed ?? 0) > 0 ? `${s.failed} failed` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function CampaignsView({
  user,
  onOpenCustomer,
}: {
  user: SessionUser;
  onOpenCustomer: (id: string) => void;
}) {
  return (
    <div className="space-y-8">
      <CampaignsSection user={user} onOpenCustomer={onOpenCustomer} />
      <FollowUpSection user={user} />
    </div>
  );
}

/* ================================================================== */
/* Campaigns list + builder                                           */
/* ================================================================== */

function CampaignsSection({
  user,
  onOpenCustomer,
}: {
  user: SessionUser;
  onOpenCustomer: (id: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<SendRunSummaryResponse["summary"] | null>(null);
  const [summaryCampaign, setSummaryCampaign] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.get<CampaignsResponse>("/api/campaigns"),
  });

  const campaigns = data?.campaigns.filter((c) => !c.automated) ?? [];
  const autoCampaigns = data?.campaigns.filter((c) => c.automated) ?? [];
  const providerMode = data?.providerMode.mode ?? "SIMULATION";

  function handleSendResult(campaignName: string, res: SendRunSummaryResponse) {
    setLastSummary(res.summary);
    setSummaryCampaign(campaignName);
    queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["campaign", detailId] });
    queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
    queryClient.invalidateQueries({ queryKey: ["audit"] });
    queryClient.invalidateQueries({ queryKey: ["customer"] });
  }

  return (
    <div>
      <SectionHeading
        title="Campaigns"
        description={`Create personalised offers for a guest segment. Every message respects marketing consent.`}
        action={
          <Button onClick={() => setBuilderOpen(true)}>
            <Wand2 className="h-4 w-4" /> Create Campaign
          </Button>
        }
      />

      {providerMode === "SIMULATION" && (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
          <FlaskConical className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Simulation mode</p>
            <p className="mt-0.5 leading-relaxed">
              The full send pipeline runs and everything is recorded, but no real WhatsApp/SMS goes
              out. Add provider credentials (<code className="text-[12px]">WHATSAPP_TOKEN</code> /{" "}
              <code className="text-[12px]">TWILIO_ACCOUNT_SID</code>) to go live.
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No campaigns yet"
          description='Create your first campaign — e.g. "Diwali Returning Customer Offer" — and send it to a segment.'
          action={
            <Button onClick={() => setBuilderOpen(true)}>
              <Wand2 className="h-4 w-4" /> Create Campaign
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              onOpen={() => setDetailId(c.id)}
              onSent={handleSendResult}
            />
          ))}
        </div>
      )}

      {/* Automated campaigns (engine-generated) */}
      {autoCampaigns.length > 0 && (
        <div className="mt-6">
          <SectionHeading
            title="Automated campaigns"
            description="Generated by your Follow-up Engine below — they send on schedule after checkout."
          />
          <div className="space-y-3">
            {autoCampaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                onOpen={() => setDetailId(c.id)}
                onSent={handleSendResult}
              />
            ))}
          </div>
        </div>
      )}

      <CampaignBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        hotelName={user.hotelName}
        onSent={handleSendResult}
      />
      <CampaignDetailDialog
        id={detailId}
        onClose={() => setDetailId(null)}
        onOpenCustomer={(id) => {
          setDetailId(null);
          onOpenCustomer(id);
        }}
        onSent={handleSendResult}
      />

      {/* Send summary dialog */}
      <Dialog open={lastSummary !== null} onOpenChange={(o) => !o && setLastSummary(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4 text-primary" /> Send complete — {summaryCampaign}
            </DialogTitle>
            <DialogDescription>{lastSummary ? summarizeSend(lastSummary) : ""}</DialogDescription>
          </DialogHeader>
          {lastSummary && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <SummaryTile label="Audience" value={lastSummary.audienceSize} />
                <SummaryTile label="Consent-eligible" value={lastSummary.eligible} />
                <SummaryTile label="Sent" value={lastSummary.sent} />
                <SummaryTile label="Skipped" value={lastSummary.skipped} />
                {lastSummary.failed > 0 && (
                  <SummaryTile label="Failed" value={lastSummary.failed} />
                )}
                {lastSummary.rateLimited > 0 && (
                  <SummaryTile label="Rate-limited" value={lastSummary.rateLimited} />
                )}
              </div>
              {Object.keys(lastSummary.skippedReasons).length > 0 && (
                <div className="rounded-lg border bg-accent/30 p-3 text-xs space-y-1">
                  {Object.entries(lastSummary.skippedReasons).map(([reason, count]) => (
                    <p key={reason}>
                      <span className="font-medium">{SKIP_REASON_LABELS[reason] ?? reason}:</span>{" "}
                      {count}
                    </p>
                  ))}
                </div>
              )}
              {lastSummary.providerMode === "SIMULATION" && (
                <p className="text-xs text-muted-foreground">
                  Simulation mode — messages recorded, nothing really delivered.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setLastSummary(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{formatNumber(value)}</p>
    </div>
  );
}

function CampaignCard({
  campaign,
  onOpen,
  onSent,
}: {
  campaign: CampaignRow;
  onOpen: () => void;
  onSent: (name: string, summary: SendRunSummaryResponse) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sendMutation = useMutation({
    mutationFn: () => api.post<SendRunSummaryResponse>(`/api/campaigns/${campaign.id}/send`, {}),
    onSuccess: (res) => {
      setConfirmOpen(false);
      onSent(campaign.name, res);
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast({
        title: "Send blocked",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Phase 6.4 — retry failed deliveries (max 3 attempts, backoff-aware)
  const retryMutation = useMutation({
    mutationFn: () =>
      api.post<{
        summary: {
          candidates: number;
          retried: number;
          sent: number;
          simulated: number;
          stillFailed: number;
          exhausted: number;
        };
      }>(`/api/campaigns/${campaign.id}/retry`, {}),
    onSuccess: (res) => {
      const s = res.summary;
      const delivered = s.sent + s.simulated;
      toast({
        title:
          delivered > 0
            ? `Retry delivered ${delivered} message${delivered === 1 ? "" : "s"}`
            : "Retry finished",
        description:
          `${s.retried} of ${s.candidates} failed messages retried` +
          (s.stillFailed > 0 ? ` · ${s.stillFailed} still failing (backoff applies)` : "") +
          (s.exhausted > 0 ? ` · ${s.exhausted} exhausted (max 3 attempts)` : ""),
      });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
    },
    onError: (err) => {
      toast({
        title: "Retry blocked",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <button
            type="button"
            onClick={onOpen}
            className="text-left min-w-0 flex-1 focus:outline-none"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold tracking-tight">{campaign.name}</p>
              <Badge
                variant={campaign.status === "COMPLETED" ? "secondary" : "outline"}
                className="text-[10px]"
              >
                {STATUS_LABELS[campaign.status] ?? campaign.status}
              </Badge>
              {campaign.offer && (
                <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-0 text-[10px]">
                  {campaign.offer}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Audience: {campaign.audienceSegment?.name ?? "—"} · {campaign.audienceSize} guest
              {campaign.audienceSize === 1 ? "" : "s"}
              {campaign.scheduledAt && ` · scheduled ${formatDateTime(campaign.scheduledAt)}`}
              {campaign.lastSentAt && ` · last sent ${formatDateTime(campaign.lastSentAt)}`}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                {campaign.channels.map((ch) => {
                  const Meta = CHANNEL_META[ch];
                  return Meta ? (
                    <span key={ch} className="inline-flex items-center gap-1">
                      <Meta.icon className="h-3.5 w-3.5" /> {Meta.label}
                    </span>
                  ) : null;
                })}
              </span>
              <span>· {formatNumber(campaign.stats.sent)} sent</span>
              {campaign.stats.skipped > 0 && <span>· {campaign.stats.skipped} skipped</span>}
              {campaign.stats.bookings > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  · {campaign.stats.bookings} booking{campaign.stats.bookings === 1 ? "" : "s"} · ₹
                  {formatNumber(campaign.stats.revenue)}
                </span>
              )}
            </div>
          </button>
          <div className="flex items-center gap-2">
            {campaign.stats.failed > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || sendMutation.isPending}
                title="Retry failed deliveries (max 3 attempts, exponential backoff)"
              >
                {retryMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                Retry {campaign.stats.failed} failed
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={sendMutation.isPending}
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {campaign.stats.sent > 0 ? "Send to new guests" : "Send Now"}
            </Button>
          </div>
        </div>
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send &quot;{campaign.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Messages go to eligible guests in <b>{campaign.audienceSegment?.name}</b> — only those
              with marketing consent who haven&apos;t opted out. Guests without consent are skipped
              and listed with reasons.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                sendMutation.mutate();
              }}
            >
              {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/* ================================================================== */
/* Campaign builder                                                   */
/* ================================================================== */

function CampaignBuilderDialog({
  open,
  onOpenChange,
  hotelName,
  onSent,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  hotelName: string;
  onSent: (name: string, summary: SendRunSummaryResponse) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [channels, setChannels] = useState<string[]>(["WHATSAPP"]);
  const [offer, setOffer] = useState("");
  const [template, setTemplate] = useState(
    "Hi {{name}}, thank you for staying at {{hotel_name}}! Come back soon and enjoy {{offer}}: {{booking_link}}",
  );
  // RECHECK FIX (D): optional WhatsApp approved-template binding. When an
  // APPROVED template is selected, WhatsApp sends use the provider TEMPLATE
  // payload (works 24/7, not just inside the 24-hour session window).
  const [waTemplateId, setWaTemplateId] = useState("");

  // Phase 6.3 — pick a ready-made template to pre-fill the message.
  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<TemplatesResponse>("/api/templates"),
  });
  const templateList = templatesQuery.data?.templates ?? [];
  const [schedule, setSchedule] = useState<"NOW" | "SCHEDULED">("NOW");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const [testPreview, setTestPreview] = useState<string | null>(null);

  const { data: segmentsData } = useQuery({
    queryKey: ["segments"],
    queryFn: () => api.get<import("@/lib/types").SegmentsResponse>("/api/segments"),
    enabled: open,
  });
  const { data: campaignsData } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.get<CampaignsResponse>("/api/campaigns"),
    enabled: open,
  });

  const variables = campaignsData?.templateVariables ?? [];

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<{ campaign: CampaignRow }>("/api/campaigns", {
        name: name.trim(),
        segmentId,
        channels,
        offer: offer.trim() || undefined,
        messageTemplate: template.trim(),
        ...(waTemplateId ? { messageTemplateId: waTemplateId } : {}),
        scheduleType: schedule,
        scheduledAt: schedule === "SCHEDULED" ? new Date(scheduledAt).toISOString() : undefined,
      }),
    onSuccess: async (res) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({ title: "Campaign created", description: `"${res.campaign.name}" is ready.` });
      // If "Now", send right away
      if (schedule === "NOW") {
        try {
          const sendRes = await api.post<SendRunSummaryResponse>(
            `/api/campaigns/${res.campaign.id}/send`,
            {},
          );
          onSent(res.campaign.name, sendRes);
        } catch {
          toast({
            title: "Created, but send failed",
            description: `Open "${res.campaign.name}" and press Send Now.`,
            variant: "destructive",
          });
        }
      }
      onOpenChange(false);
      resetForm();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Campaign could not be created."),
  });

  const testMutation = useMutation({
    mutationFn: (campaignId: string) =>
      api.post<{ preview: string; message: string }>(`/api/campaigns/${campaignId}/test`, {
        phone: testPhone.trim() || undefined,
      }),
    onSuccess: (res) => {
      setTestPreview(res.preview);
      toast({ title: "Test message", description: res.message });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Test could not be sent."),
  });

  function resetForm() {
    setName("");
    setSegmentId("");
    setChannels(["WHATSAPP"]);
    setOffer("");
    setTemplate(
      "Hi {{name}}, thank you for staying at {{hotel_name}}! Come back soon and enjoy {{offer}}: {{booking_link}}",
    );
    setWaTemplateId("");
    setSchedule("NOW");
    setScheduledAt("");
    setError(null);
    setTestPhone("");
    setTestPreview(null);
  }

  function toggleChannel(ch: string) {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));
  }

  function insertVariable(key: string) {
    setTemplate((t) => `${t}${t.endsWith(" ") || t === "" ? "" : " "}${key}`);
  }

  // Local preview with sample data
  const localPreview = template
    .replaceAll("{{name}}", "Ankit")
    .replaceAll("{{hotel_name}}", hotelName)
    .replaceAll("{{last_visit}}", "12 Oct 2026")
    .replaceAll("{{booking_count}}", "3")
    .replaceAll("{{offer}}", offer.trim() || "20% OFF")
    .replaceAll("{{booking_link}}", "https://book.example/abc");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Create Campaign
          </DialogTitle>
          <DialogDescription>
            Choose an audience, write a personalised message, and send — consent is checked
            automatically.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="c-name">Campaign name *</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Diwali Returning Customer Offer"
              maxLength={80}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Audience segment *</Label>
              <Select value={segmentId} onValueChange={setSegmentId}>
                <SelectTrigger aria-label="Audience segment">
                  <SelectValue placeholder="Select a segment…" />
                </SelectTrigger>
                <SelectContent>
                  {(segmentsData?.segments ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.memberCount})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Guests without marketing consent are skipped automatically.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-offer">Offer (optional)</Label>
              <Input
                id="c-offer"
                value={offer}
                onChange={(e) => setOffer(e.target.value)}
                placeholder="e.g. 20% OFF"
                maxLength={80}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Channels *</Label>
            <div className="flex flex-wrap gap-3">
              {Object.entries(CHANNEL_META).map(([key, meta]) => (
                <label
                  key={key}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer hover:bg-accent/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <Checkbox
                    checked={channels.includes(key)}
                    onCheckedChange={() => toggleChannel(key)}
                  />
                  <meta.icon className="h-4 w-4" />
                  {meta.label}
                </label>
              ))}
            </div>
          </div>

          {templateList.length > 0 ? (
            <div className="space-y-2">
              <Label>Start from a template (Phase 6.3)</Label>
              <Select
                value=""
                onValueChange={(id) => {
                  const t = templateList.find((x) => x.id === id);
                  if (t) {
                    setTemplate(t.body);
                    setChannels(t.channels.length ? t.channels : channels);
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a saved template…" />
                </SelectTrigger>
                <SelectContent>
                  {templateList.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · {t.category.replace(/_/g, " ").toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="c-msg">Message *</Label>
            <div className="flex flex-wrap gap-1">
              {variables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  title={v.description}
                  onClick={() => insertVariable(v.key)}
                  className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-mono text-primary hover:bg-primary/20"
                >
                  {v.key}
                </button>
              ))}
            </div>
            <Textarea
              id="c-msg"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={4}
              maxLength={1600}
              placeholder="Write your message…"
            />
            <div className="rounded-lg bg-accent/40 border px-3 py-2.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Preview (sample data)
              </p>
              <p className="text-sm">{localPreview}</p>
            </div>
          </div>

          {/* RECHECK FIX (D): WhatsApp approved-template binding */}
          {channels.includes("WHATSAPP") ? (
            <div className="space-y-2">
              <Label>WhatsApp template (optional)</Label>
              <Select
                value={waTemplateId || "__none__"}
                onValueChange={(v) => setWaTemplateId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger aria-label="WhatsApp template">
                  <SelectValue placeholder="Free-form text (24-hour window only)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Free-form text (24-hour window only)</SelectItem>
                  {templateList
                    .filter((t) => t.channels.includes("WHATSAPP") && t.providerTemplateId)
                    .map((t) => (
                      <SelectItem
                        key={t.id}
                        value={t.id}
                        disabled={t.approvalStatus !== "APPROVED"}
                      >
                        {t.name} · {t.providerTemplateId} ({t.languageCode ?? "?"})
                        {t.approvalStatus === "APPROVED"
                          ? " — approved ✓"
                          : ` — ${t.approvalStatus?.toLowerCase() ?? "not bound"} (not sendable)`}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Meta only delivers free-form WhatsApp inside 24 hours of the customer&apos;s last
                message. Bind an APPROVED template (set up on the Templates page with its provider
                name, language and variables) to message any time. Only approved templates are
                selectable.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Schedule</Label>
            <RadioGroup
              value={schedule}
              onValueChange={(v) => setSchedule(v as "NOW" | "SCHEDULED")}
              className="flex gap-4"
            >
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="NOW" /> Send immediately
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <RadioGroupItem value="SCHEDULED" /> Schedule for later
              </label>
            </RadioGroup>
            {schedule === "SCHEDULED" && (
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="max-w-xs"
                aria-label="Scheduled date and time"
              />
            )}
          </div>

          <details className="rounded-lg border px-3 py-2.5">
            <summary className="text-sm font-medium cursor-pointer flex items-center gap-1.5">
              <FlaskConical className="h-3.5 w-3.5 text-primary" /> Test message (optional)
            </summary>
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Input
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="Phone for test (blank = hotel phone)"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    // create silently then test — using two-step to keep builder simple
                    createTestFlow();
                  }}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Send test
                </Button>
              </div>
              {testPreview && (
                <div className="rounded-lg bg-accent/40 border px-3 py-2 text-sm">
                  {testPreview}
                </div>
              )}
            </div>
          </details>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setError(null);
              createMutation.mutate();
            }}
            disabled={
              createMutation.isPending ||
              name.trim().length < 3 ||
              !segmentId ||
              channels.length === 0
            }
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {schedule === "NOW" ? "Save & Send" : "Save Campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function createTestFlow() {
    // Test needs a campaign; create a lightweight draft first if fields valid
    if (name.trim().length < 3 || !segmentId) {
      setError("Fill the campaign name and audience before sending a test.");
      return;
    }
    (async () => {
      try {
        const created = await api.post<{ campaign: CampaignRow }>("/api/campaigns", {
          name: `${name.trim()} (test)`,
          segmentId,
          channels,
          offer: offer.trim() || undefined,
          messageTemplate: template.trim(),
          scheduleType: "NOW",
        });
        await api.post(`/api/campaigns/${created.campaign.id}/test`, {
          phone: testPhone.trim() || undefined,
        });
        await api.patch(`/api/campaigns/${created.campaign.id}`, {}).catch(() => null);
        // archive the test campaign so it does not clutter the list
        await api.delete(`/api/campaigns/${created.campaign.id}`);
        const preview = template
          .replaceAll("{{name}}", "Ankit")
          .replaceAll("{{hotel_name}}", hotelName)
          .replaceAll("{{offer}}", offer || "20% OFF")
          .replaceAll("{{booking_link}}", "https://book.example/abc")
          .replaceAll("{{last_visit}}", "12 Oct 2026")
          .replaceAll("{{booking_count}}", "3");
        setTestPreview(`[TEST] ${preview}`);
        queryClient.invalidateQueries({ queryKey: ["campaigns"] });
        toast({ title: "Test message", description: "Test processed through the send pipeline." });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Test could not be sent.");
      }
    })();
  }
}

/* ================================================================== */
/* Campaign detail + analytics                                        */
/* ================================================================== */

function CampaignDetailDialog({
  id,
  onClose,
  onOpenCustomer,
  onSent,
}: {
  id: string | null;
  onClose: () => void;
  onOpenCustomer: (id: string) => void;
  onSent: (name: string, summary: SendRunSummaryResponse) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [bookingMsg, setBookingMsg] = useState<CampaignMessageRowExtended | null>(null);
  const [bookingAmount, setBookingAmount] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["campaign", id],
    queryFn: () => api.get<CampaignDetailResponse>(`/api/campaigns/${id}`),
    enabled: id !== null,
  });

  const attributeMutation = useMutation({
    mutationFn: (input: { customerId: string; amount: number; channel?: string }) =>
      api.post(`/api/campaigns/${id}/attribute-booking`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
      toast({ title: "Booking recorded", description: "Revenue attributed to this campaign." });
      setBookingMsg(null);
      setBookingAmount("");
    },
    onError: (err) =>
      toast({
        title: "Could not record booking",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const stats = data?.stats;

  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto">
        {isLoading || !data ? (
          <div className="space-y-4 py-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
                {data.campaign.name}
                <Badge variant="outline" className="text-[10px]">
                  {STATUS_LABELS[data.campaign.status] ?? data.campaign.status}
                </Badge>
                {data.campaign.automated && (
                  <Badge className="bg-violet-500/15 text-violet-700 dark:text-violet-400 border-0 text-[10px]">
                    <Bot className="h-3 w-3 mr-1" /> Automated
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription>
                {data.campaign.audienceSegment
                  ? `Audience: ${data.campaign.audienceSegment.name}`
                  : "No audience"}
                {data.campaign.offer && ` · Offer: ${data.campaign.offer}`}
                {` · Channels: ${data.campaign.channels.map((c) => CHANNEL_META[c]?.label ?? c).join(", ")}`}
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="analytics">
              <TabsList>
                <TabsTrigger value="analytics">Analytics</TabsTrigger>
                <TabsTrigger value="messages">Messages ({data.messages.length})</TabsTrigger>
                <TabsTrigger value="template">Template</TabsTrigger>
              </TabsList>

              <TabsContent value="analytics" className="space-y-4 pt-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <FunnelTile label="Sent" value={stats?.sent ?? 0} icon={Send} />
                  <FunnelTile
                    label="Delivered"
                    value={stats?.delivered ?? 0}
                    icon={Mail}
                    hint={pct(stats?.deliveryRate)}
                  />
                  <FunnelTile
                    label="Opened"
                    value={stats?.opened ?? 0}
                    icon={MousePointerClick}
                    hint={pct(stats?.openRate)}
                  />
                  <FunnelTile
                    label="Clicked"
                    value={stats?.clicked ?? 0}
                    icon={MousePointerClick}
                    hint={pct(stats?.clickRate)}
                  />
                  <FunnelTile label="Bookings" value={stats?.bookings ?? 0} icon={Users} />
                  <FunnelTile
                    label="Revenue"
                    value={stats?.revenue ?? 0}
                    icon={CircleDollarSign}
                    prefix="₹"
                  />
                  <FunnelTile
                    label="Skipped"
                    value={stats?.skipped ?? 0}
                    icon={Users}
                    hint="no consent / limits"
                  />
                  <FunnelTile
                    label="ROI"
                    value={stats?.roi != null ? `${stats.roi.toFixed(1)}x` : "—"}
                    icon={CircleDollarSign}
                    hint={
                      stats && stats.estimatedCost > 0
                        ? `est. cost ₹${formatNumber(stats.estimatedCost)}`
                        : "no sends yet"
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Delivery/open/click numbers update when your provider&apos;s webhooks report
                  events (POST /api/tracking/webhook). In simulation mode nothing is fabricated —
                  they stay at zero.
                </p>
              </TabsContent>

              <TabsContent value="messages" className="pt-2">
                {data.messages.length === 0 ? (
                  <EmptyState
                    icon={Send}
                    title="No messages yet"
                    description="Send the campaign to generate messages."
                  />
                ) : (
                  <div className="max-h-[360px] overflow-y-auto rounded-xl border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-card z-10">
                        <TableRow>
                          <TableHead>Guest</TableHead>
                          <TableHead>Channel</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Sent</TableHead>
                          <TableHead className="text-right">Booking</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.messages.map((m) => (
                          <TableRow key={m.id}>
                            <TableCell>
                              <button
                                type="button"
                                className="font-medium hover:underline focus:outline-none"
                                onClick={() => onOpenCustomer(m.customerId)}
                              >
                                {m.customerName}
                              </button>
                              <p className="text-xs text-muted-foreground">
                                {maskPhoneDisplay(m.customerPhone)}
                              </p>
                            </TableCell>
                            <TableCell className="text-sm">
                              {CHANNEL_META[m.channel]?.label ?? m.channel}
                            </TableCell>
                            <TableCell>
                              <MessageStatusBadge
                                status={m.status}
                                skipReason={m.skipReason}
                                provider={m.provider}
                              />
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {formatDateTime(m.sentAt)}
                            </TableCell>
                            <TableCell className="text-right">
                              {m.bookingLinked ? (
                                <span className="text-emerald-600 dark:text-emerald-400 text-sm font-medium">
                                  ₹{formatNumber(m.bookingAmount ?? 0)}
                                </span>
                              ) : m.status === "SENT" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => setBookingMsg(m)}
                                >
                                  Record booking
                                </Button>
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="template" className="pt-2 space-y-3">
                <div className="rounded-lg bg-accent/40 border px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm">{data.campaign.messageTemplate}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Variables used:{" "}
                  {data.campaign.messageTemplate.match(/\{\{\w+\}\}/g)?.join(", ") || "none"}
                </p>
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>

      {/* Record booking dialog */}
      <Dialog open={bookingMsg !== null} onOpenChange={(o) => !o && setBookingMsg(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record booking</DialogTitle>
            <DialogDescription>
              {bookingMsg?.customerName} booked after this campaign&apos;s{" "}
              {bookingMsg?.channel.toLowerCase()} message. Enter the booking value for revenue
              attribution.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="b-amount">Booking amount (₹) *</Label>
            <Input
              id="b-amount"
              type="number"
              min="1"
              value={bookingAmount}
              onChange={(e) => setBookingAmount(e.target.value)}
              placeholder="e.g. 6200"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBookingMsg(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (bookingMsg && Number(bookingAmount) > 0) {
                  attributeMutation.mutate({
                    customerId: bookingMsg.customerId,
                    amount: Number(bookingAmount),
                    channel: bookingMsg.channel,
                  });
                }
              }}
              disabled={attributeMutation.isPending || !bookingAmount || Number(bookingAmount) <= 0}
            >
              {attributeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

type CampaignMessageRowExtended = CampaignDetailResponse["messages"][number];

function FunnelTile({
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
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-muted-foreground">{label}</p>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <p className="mt-1.5 text-xl font-bold tabular-nums">
        {prefix}
        {typeof value === "number" ? formatNumber(value) : value}
      </p>
      {hint && <p className="text-[10.5px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

function pct(v: number | null | undefined): string | undefined {
  return v != null ? `${Math.round(v * 100)}%` : undefined;
}

function MessageStatusBadge({
  status,
  skipReason,
  provider,
}: {
  status: string;
  skipReason: string | null;
  provider: string | null;
}) {
  if (status === "SENT") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Sent</span>
        {provider === "SIMULATION" && (
          <span className="text-[9.5px] text-amber-600 dark:text-amber-400">simulated</span>
        )}
      </div>
    );
  }
  // Phase 6.4 — honest simulation status (never displayed as a real send)
  if (status === "SIMULATED") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Simulated</span>
        <span className="text-[9.5px] text-muted-foreground">no real message sent</span>
      </div>
    );
  }
  if (status === "SKIPPED") {
    return (
      <span className="text-xs text-muted-foreground">
        Skipped — {SKIP_REASON_LABELS[skipReason ?? ""] ?? skipReason ?? "unknown"}
      </span>
    );
  }
  if (status === "FAILED") {
    return <span className="text-xs text-destructive">Failed</span>;
  }
  return <span className="text-xs text-muted-foreground">Pending</span>;
}

/* ================================================================== */
/* Smart Follow-up Engine settings                                    */
/* ================================================================== */

function FollowUpSection({ user }: { user: SessionUser }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editDays, setEditDays] = useState("1");
  const [editTemplate, setEditTemplate] = useState("");
  const [editChannels, setEditChannels] = useState<string[]>([]);
  const [runResult, setRunResult] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["followups"],
    queryFn: () => api.get<{ steps: FollowUpStepRow[] }>("/api/campaigns/run-engine"),
  });

  const updateMutation = useMutation({
    mutationFn: (input: Record<string, unknown>) => api.put("/api/follow-ups", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["followups"] });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      toast({
        title: "Follow-up updated",
        description: "Your changes are live for future checkouts.",
      });
      setEditingId(null);
    },
    onError: (err) =>
      toast({
        title: "Could not save",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      api.post<{
        result: { sent: number; skipped: number; failed: number; customersProcessed: number };
      }>("/api/campaigns/run-engine", {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["followups"] });
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-overview"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      setRunResult(
        `${res.result.customersProcessed} guest${res.result.customersProcessed === 1 ? "" : "s"} matched today's follow-up schedule — ${res.result.sent} sent, ${res.result.skipped} skipped (consent/limits), ${res.result.failed} failed.`,
      );
      toast({ title: "Engine ran", description: "Check automated campaigns below for results." });
    },
    onError: (err) =>
      toast({
        title: "Engine could not run",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  function startEdit(step: FollowUpStepRow) {
    setEditingId(step.id);
    setEditLabel(step.label);
    setEditDays(String(step.offsetDays));
    setEditTemplate(step.messageTemplate);
    setEditChannels(step.channels);
  }

  return (
    <div>
      <SectionHeading
        title="Smart Follow-up Engine"
        description="Automatic messages after checkout — +1 day thank-you, +7 review request, +30 return offer, +60 special, +90 win-back. Timings and templates are yours to tune."
        action={
          <Button
            variant="outline"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
          >
            {runMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
            Run Engine Now
          </Button>
        }
      />

      {runResult && (
        <p className="mb-4 rounded-lg border bg-accent/40 px-3 py-2 text-sm">{runResult}</p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.steps ?? []).map((step, idx) => (
            <div key={step.id}>
              {editingId === step.id ? (
                <div className="rounded-xl border-2 border-primary/40 bg-card p-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`fu-label-${step.id}`}>Step name</Label>
                      <Input
                        id={`fu-label-${step.id}`}
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`fu-days-${step.id}`}>Days after checkout</Label>
                      <Input
                        id={`fu-days-${step.id}`}
                        type="number"
                        min="1"
                        max="365"
                        value={editDays}
                        onChange={(e) => setEditDays(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Channels</Label>
                      <div className="flex gap-2 pt-1.5">
                        {Object.entries(CHANNEL_META).map(([key, meta]) => (
                          <label
                            key={key}
                            className="flex items-center gap-1 text-xs cursor-pointer"
                          >
                            <Checkbox
                              checked={editChannels.includes(key)}
                              onCheckedChange={() =>
                                setEditChannels((prev) =>
                                  prev.includes(key)
                                    ? prev.filter((c) => c !== key)
                                    : [...prev, key],
                                )
                              }
                            />
                            <meta.icon className="h-3.5 w-3.5" />
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`fu-tpl-${step.id}`}>Message template</Label>
                    <Textarea
                      id={`fu-tpl-${step.id}`}
                      value={editTemplate}
                      onChange={(e) => setEditTemplate(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        updateMutation.mutate({
                          id: step.id,
                          label: editLabel.trim(),
                          offsetDays: Number(editDays),
                          messageTemplate: editTemplate.trim(),
                          channels: editChannels,
                        })
                      }
                      disabled={updateMutation.isPending}
                    >
                      {updateMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Save step
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border bg-card p-4 flex flex-wrap items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/12 text-violet-600 dark:text-violet-400 shrink-0">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm flex items-center gap-2">
                      +{step.offsetDays} day{step.offsetDays === 1 ? "" : "s"} · {step.label}
                      {idx < (data?.steps.length ?? 0) - 1 && (
                        <span className="text-muted-foreground font-normal">→</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {step.messageTemplate}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {step.channels.map((c) => CHANNEL_META[c]?.label ?? c).join(", ")}
                    </span>
                    <Switch
                      checked={step.enabled}
                      onCheckedChange={(checked) =>
                        updateMutation.mutate({ id: step.id, enabled: checked })
                      }
                      aria-label={`${step.enabled ? "Disable" : "Enable"} ${step.label}`}
                    />
                    <Button size="sm" variant="outline" onClick={() => startEdit(step)}>
                      Edit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Production tip: schedule a daily job (cron) to POST <code>/api/campaigns/run-engine</code>{" "}
        with the
        <code> x-engine-secret</code> header — it runs for every hotel automatically.
      </p>
    </div>
  );
}

interface FollowUpStepRow {
  id: string;
  offsetDays: number;
  label: string;
  messageTemplate: string;
  channels: string[];
  enabled: boolean;
  eligibleToday?: number;
}
