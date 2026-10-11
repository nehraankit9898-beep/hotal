"use client";

/**
 * Phase 18 — AI Console (owner view).
 *
 * Four panels, all honest by construction:
 *  1. GOVERNANCE — feature flags (owner/admin only can toggle) + budget caps.
 *     The modelProvider row states plainly: rule-based only; no external
 *     model is configured and none may be claimed.
 *  2. RECOMMENDATIONS — RULE_BASED candidates requiring explicit human
 *     approval. Approve sends via the tenant provider; dismiss discards.
 *     Scores are rule scores — the UI never shows them as "conversion %".
 *  3. FORECASTS — advisory weekday moving-average with NOT_ENOUGH_DATA rows
 *     rendered as "insufficient data", never as a number.
 *  4. WHATSAPP CHATBOT — conversation list with server-priced cart totals.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Sparkles, Bot, TrendingUp, ShieldCheck, Info, Check, X, RefreshCw, Wallet, Leaf,
} from "lucide-react";
import type { SessionUser } from "@/lib/types";
import { useState } from "react";

/* ------------------------------------------------------------------ */
/* API types                                                           */
/* ------------------------------------------------------------------ */

interface AISettingsData {
  chatbotEnabled: boolean;
  chatbotServiceHours: unknown;
  recommendationsEnabled: boolean;
  forecastingEnabled: boolean;
  voiceEnabled: boolean;
  walletEnabled: boolean;
  sustainabilityEnabled: boolean;
  modelProvider: string;
  dailyRequestCap: number;
  monthlyRequestCap: number;
  handoffPhone: string | null;
}

interface RecommendationRow {
  id: string;
  basis: string;
  ruleId: string;
  reasonCode: string;
  score: number | null;
  status: string;
  channel: string;
  customer: { id: string; name: string } | null;
  coupon: { code: string; discountType: string; discountValue: number } | null;
  errorMessage: string | null;
  createdAt: string;
}

interface ForecastRow {
  id: string;
  menuItemName: string | null;
  businessDate: string;
  forecastQty: number | null;
  upperBound: number | null;
  dataStatus: "OK" | "NOT_ENOUGH_DATA";
  dataPoints: number;
  skill: number | null;
}

interface ConversationRow {
  id: string;
  phone: string;
  customerName: string | null;
  state: string;
  cart: Array<{ name: string; quantity: number; lineTotalMinor: number }>;
  cartTotalMinor: number;
  messageCount: number;
  lastActivityAt: string;
}

function money(minor: number): string {
  return `₹${(minor / 100).toFixed(0)}`;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function AiView({ user }: { user: SessionUser }) {
  const isOwnerAdmin = user.role === "HOTEL_OWNER" || user.role === "HOTEL_ADMIN";

  const settingsQ = useQuery({
    queryKey: ["ai", "settings"],
    queryFn: () => api.get<{ settings: AISettingsData }>("/api/ai/settings"),
  });
  const recsQ = useQuery({
    queryKey: ["ai", "recommendations"],
    queryFn: () => api.get<{ recommendations: RecommendationRow[] }>("/api/ai/recommendations?status=PENDING"),
    refetchInterval: 30_000,
  });
  const forecastQ = useQuery({
    queryKey: ["ai", "forecast"],
    queryFn: () => api.get<{ forecasts: ForecastRow[] }>("/api/ai/forecast"),
  });
  const convQ = useQuery({
    queryKey: ["ai", "conversations"],
    queryFn: () => api.get<{ conversations: ConversationRow[] }>("/api/ai/conversations"),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> AI Assistant
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Rule-based assistants — every action is audited, every send needs human approval.
          </p>
        </div>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Rule-based engine (modelProvider: NONE)</AlertTitle>
        <AlertDescription>
          No external AI provider is configured. All features below are transparent,
          deterministic rules over your own data — no invented probabilities, no automated
          messages without approval, forecasts are advisory only.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="governance" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="governance" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Governance</TabsTrigger>
          <TabsTrigger value="recommendations" className="gap-1.5"><Bot className="h-3.5 w-3.5" /> Offers</TabsTrigger>
          <TabsTrigger value="forecast" className="gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> Forecast</TabsTrigger>
          <TabsTrigger value="chatbot" className="gap-1.5"><Bot className="h-3.5 w-3.5" /> WhatsApp Bot</TabsTrigger>
          <TabsTrigger value="wallet" className="gap-1.5"><Wallet className="h-3.5 w-3.5" /> Wallet</TabsTrigger>
        </TabsList>

        <TabsContent value="governance">
          <GovernancePanel
            user={user}
            isOwnerAdmin={isOwnerAdmin}
            settings={settingsQ.data?.settings}
            loading={settingsQ.isLoading}
          />
        </TabsContent>

        <TabsContent value="recommendations">
          <RecommendationsPanel
            canManage={isOwnerAdmin || user.role === "MARKETING_MANAGER"}
            query={recsQ}
          />
        </TabsContent>

        <TabsContent value="forecast">
          <ForecastPanel
            query={forecastQ}
          />
        </TabsContent>

        <TabsContent value="chatbot">
          <ChatbotPanel query={convQ} />
        </TabsContent>

        <TabsContent value="wallet">
          <WalletPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Governance panel                                                    */
/* ------------------------------------------------------------------ */

function GovernancePanel({
  user,
  isOwnerAdmin,
  settings,
  loading,
}: {
  user: SessionUser;
  isOwnerAdmin: boolean;
  settings?: AISettingsData;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api.patch<{ settings: AISettingsData }>("/api/ai/settings", changes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "settings"] });
    },
  });

  if (loading || !settings) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const flags: Array<{ key: keyof AISettingsData; label: string; hint: string }> = [
    { key: "chatbotEnabled", label: "WhatsApp ordering chatbot", hint: "Customers can browse and order via your WhatsApp business number." },
    { key: "recommendationsEnabled", label: "Offer recommendations", hint: "Rule-based offers for silent/birthday/loyal guests — approval required per send." },
    { key: "forecastingEnabled", label: "Demand forecasting", hint: "Advisory per-item demand estimates from your order history." },
    { key: "voiceEnabled", label: "Voice order support", hint: "Speech-to-cart on the staff POS (microphone stays on the device)." },
    { key: "walletEnabled", label: "Loyalty wallet passes", hint: "Issue loyalty pass records (provider distribution needs credentials)." },
    { key: "sustainabilityEnabled", label: "Sustainability badges", hint: "Self-reported badges shown on the public menu, clearly labelled." },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Features</CardTitle>
          <CardDescription>
            {isOwnerAdmin
              ? "Toggle AI features for your restaurant. All default OFF."
              : "Only the owner/admin can change these switches."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flags.map((f) => (
            <div key={String(f.key)} className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{f.label}</p>
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
              <Switch
                checked={Boolean(settings[f.key])}
                disabled={!isOwnerAdmin || patch.isPending}
                onCheckedChange={(v) => patch.mutate({ [f.key]: v })}
                aria-label={f.label}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily budget cap</CardTitle>
            <CardDescription>Billable AI requests per day (chatbot turns, generations, forecasts).</CardDescription>
          </CardHeader>
          <CardContent>
            <CapEditor
              value={settings.dailyRequestCap}
              disabled={!isOwnerAdmin || patch.isPending}
              onSave={(v) => patch.mutate({ dailyRequestCap: v })}
              max={100000}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Human handoff number</CardTitle>
            <CardDescription>Shown when the bot is outside service hours or stuck.</CardDescription>
          </CardHeader>
          <CardContent>
            <CapEditor
              textValue={settings.handoffPhone ?? ""}
              placeholder="+9198xxxxxxxx"
              disabled={!isOwnerAdmin || patch.isPending}
              onSave={(v) => patch.mutate({ handoffPhone: v === "" ? null : v })}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CapEditor({
  value,
  textValue,
  placeholder,
  disabled,
  onSave,
  max,
}: {
  value?: number;
  textValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onSave: (v: string) => void;
  max?: number;
}) {
  const [val, setVal] = useState(textValue ?? (value !== undefined ? String(value) : ""));
  return (
    <div className="flex gap-2">
      <Input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder}
        inputMode={max ? "numeric" : "text"}
        disabled={disabled}
      />
      <Button size="sm" variant="outline" disabled={disabled || !val} onClick={() => onSave(val.trim())}>
        Save
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recommendations panel                                               */
/* ------------------------------------------------------------------ */

function RecommendationsPanel({
  canManage,
  query,
}: {
  canManage: boolean;
  query: ReturnType<typeof useQuery<{ recommendations: RecommendationRow[] }>>;
}) {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: () => api.post<{ created: number; skippedExisting: number }>("/api/ai/recommendations", { limit: 50 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "recommendations"] }),
  });
  const approve = useMutation({
    mutationFn: (id: string) => api.post<{ simulated?: boolean; message: string }>(`/api/ai/recommendations/${id}/approve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "recommendations"] }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/api/ai/recommendations/${id}/dismiss`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "recommendations"] }),
  });

  const recs = query.data?.recommendations ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Pending offers (RULE_BASED)</CardTitle>
          <CardDescription>
            Nothing is sent automatically. Approve each one; the reason shows the rule inputs.
          </CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => generate.mutate()}
          disabled={!canManage || generate.isPending}
        >
          {generate.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate candidates
        </Button>
      </CardHeader>
      <CardContent>
        {generate.data && (
          <Alert className="mb-4">
            <Info className="h-4 w-4" />
            <AlertDescription>
              {generate.data.created} new candidate(s), {generate.data.skippedExisting} already generated for this window.
            </AlertDescription>
          </Alert>
        )}
        {approve.data && (
          <Alert className="mb-4">
            <Check className="h-4 w-4" />
            <AlertDescription>{approve.data.message}</AlertDescription>
          </Alert>
        )}
        {query.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : recs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No pending offers. Click &quot;Generate candidates&quot; to scan your CRM with the rule set.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Rule & reason</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.customer?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="mr-1.5">{r.ruleId}</Badge>
                      <span className="text-xs text-muted-foreground">{r.reasonCode}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.score ?? "—"}/100 <span className="block">rule score</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate(r.id)}
                          >
                            <Check className="h-3.5 w-3.5" /> Approve & send
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={dismiss.isPending}
                            onClick={() => dismiss.mutate(r.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">view only</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Forecast panel                                                      */
/* ------------------------------------------------------------------ */

function ForecastPanel({
  query,
}: {
  query: ReturnType<typeof useQuery<{ forecasts: ForecastRow[] }>>;
}) {
  const qc = useQueryClient();
  const compute = useMutation({
    mutationFn: () => api.post<{ computed: number; insufficient: number; note: string }>("/api/ai/forecast", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "forecast"] }),
  });

  const rows = (query.data?.forecasts ?? []).filter((f) => f.businessDate <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Demand forecast (advisory)</CardTitle>
          <CardDescription>
            Weekday moving average from your real order history. Never auto-orders stock.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => compute.mutate()} disabled={compute.isPending}>
          {compute.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <TrendingUp className="h-4 w-4" />}
          Recompute
        </Button>
      </CardHeader>
      <CardContent>
        {compute.data && (
          <Alert className="mb-4">
            <Info className="h-4 w-4" />
            <AlertDescription>{compute.data.note}</AlertDescription>
          </Alert>
        )}
        {query.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No forecasts yet — click &quot;Recompute&quot; after enabling forecasting in Governance.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Expected demand</TableHead>
                  <TableHead>Data status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>{f.businessDate}</TableCell>
                    <TableCell>{f.menuItemName ?? "—"}</TableCell>
                    <TableCell>
                      {f.dataStatus === "OK" && f.forecastQty !== null ? (
                        <>
                          ~{Math.round(f.forecastQty)}
                          {f.upperBound !== null && (
                            <span className="text-xs text-muted-foreground"> (up to {Math.round(f.upperBound)})</span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {f.dataStatus === "OK" ? (
                        <Badge variant="outline">{f.dataPoints} data points</Badge>
                      ) : (
                        <Badge variant="secondary">NOT_ENOUGH_DATA</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Chatbot panel                                                       */
/* ------------------------------------------------------------------ */

function ChatbotPanel({
  query,
}: {
  query: ReturnType<typeof useQuery<{ conversations: ConversationRow[] }>>;
}) {
  const convs = query.data?.conversations ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WhatsApp conversations</CardTitle>
        <CardDescription>
          Live chatbot sessions. Cart totals are always server-priced from your current menu.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : convs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No conversations yet. Once the chatbot is enabled and your WhatsApp number receives a message, sessions appear here.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Cart</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {convs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <p className="font-medium">{c.customerName ?? "Guest"}</p>
                      <p className="text-xs text-muted-foreground">{c.phone}</p>
                    </TableCell>
                    <TableCell><Badge variant="outline">{c.state}</Badge></TableCell>
                    <TableCell className="text-xs">
                      {c.cart.length === 0 ? "—" : (
                        <>
                          {c.cart.map((l, i) => (
                            <span key={i} className="block">{l.quantity} × {l.name}</span>
                          ))}
                          <span className="font-medium">{money(c.cartTotalMinor)}</span>
                        </>
                      )}
                    </TableCell>
                    <TableCell>{c.messageCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(c.lastActivityAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Wallet panel                                                        */
/* ------------------------------------------------------------------ */

interface WalletPassRow {
  id: string;
  serialNumber: string;
  platform: string;
  status: string;
  pointsAtIssue: number;
  customerName: string | null;
}

function WalletPanel() {
  const qc = useQueryClient();
  const passesQ = useQuery({
    queryKey: ["ai", "wallet"],
    queryFn: () => api.get<{ providerStatus: string; passes: WalletPassRow[] }>("/api/wallet/passes"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/wallet/passes/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "wallet"] }),
  });

  const passes = passesQ.data?.passes ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Loyalty wallet passes
        </CardTitle>
        <CardDescription>
          Pass records are live. Distribution through the real Apple/Google Wallet APIs is
          <Badge variant="secondary" className="mx-1">BLOCKED_PROVIDER_ACCESS</Badge>
          until provider credentials are configured — no fake integration is shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {passesQ.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : passes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No passes issued yet.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {passes.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.customerName ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{p.serialNumber}</TableCell>
                    <TableCell>{p.platform}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === "ACTIVE" ? "default" : "secondary"}>{p.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {p.status === "ACTIVE" && (
                        <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(p.id)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
