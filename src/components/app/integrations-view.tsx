"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { IntegrationRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionHeading, EmptyState } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import {
  Plug,
  Plus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  KeyRound,
  ShieldCheck,
} from "lucide-react";

const INTEGRATION_TYPES: Record<string, string> = {
  WHATSAPP_CLOUD: "WhatsApp Cloud API",
  TWILIO_SMS: "Twilio SMS",
  SMTP: "SMTP Email",
  STRIPE: "Stripe Payments",
  RAZORPAY: "Razorpay Payments",
  ZOMATO: "Zomato Listings",
  SWIGGY: "Swiggy Orders",
  POS: "POS Integration",
  GOOGLE_CALENDAR: "Google Calendar",
  CALENDLY: "Calendly",
  CUSTOM_WEBHOOK: "Custom Webhook",
};

const STATUS_TONES: Record<string, string> = {
  CONNECTED: "bg-emerald-500/15 text-emerald-600",
  VERIFIED: "bg-emerald-500/15 text-emerald-600",
  SAVED_UNVERIFIED: "bg-amber-500/15 text-amber-600",
  DISCONNECTED: "bg-slate-500/15 text-slate-600",
  ERROR: "bg-rose-500/15 text-rose-600",
  PENDING: "bg-amber-500/15 text-amber-600",
};

/** RECHECK FIX (G) — provider-specific credential fields. The old UI saved
 * a generic {apiKey, apiSecret} pair for every provider, which the WhatsApp
 * verifier (token + phoneNumberId) and the Twilio verifier (sid + token +
 * from) could never use. Each type now declares exactly the fields its
 * adapter and verifier consume, with the correct credential key names. */
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  hint?: string;
}

const PROVIDER_FIELDS: Record<string, FieldDef[]> = {
  WHATSAPP_CLOUD: [
    {
      key: "token",
      label: "Permanent access token",
      placeholder: "EAAG…",
      secret: true,
      hint: "Meta Business → System user token with whatsapp_business_messaging.",
    },
    {
      key: "phoneNumberId",
      label: "Phone number ID",
      placeholder: "123456789012345",
      hint: "Meta WhatsApp → API Setup → Phone number ID.",
    },
  ],
  TWILIO_SMS: [
    { key: "accountSid", label: "Account SID", placeholder: "AC…" },
    { key: "authToken", label: "Auth token", placeholder: "••••", secret: true },
    {
      key: "fromNumber",
      label: "Sender number",
      placeholder: "+1415…",
      hint: "Twilio number or alphanumeric sender ID (E.164).",
    },
  ],
  RAZORPAY: [
    { key: "keyId", label: "Key ID", placeholder: "rzp_live_… / rzp_test_…" },
    { key: "keySecret", label: "Key secret", placeholder: "••••", secret: true },
  ],
  STRIPE: [
    { key: "secretKey", label: "Secret key", placeholder: "sk_live_… / sk_test_…", secret: true },
  ],
};

/** Generic fallback for provider types without a typed verifier (POS, Zomato…). */
const GENERIC_FIELDS: FieldDef[] = [
  { key: "apiKey", label: "API key / token", placeholder: "Token", secret: true },
  { key: "apiSecret", label: "API secret (optional)", placeholder: "Secret", secret: true },
];

function fieldsFor(type: string): FieldDef[] {
  return PROVIDER_FIELDS[type] ?? GENERIC_FIELDS;
}

/** True when this integration type has a real backend connectivity check. */
function hasVerifier(type: string): boolean {
  return ["WHATSAPP_CLOUD", "TWILIO_SMS", "RAZORPAY", "STRIPE"].includes(type);
}

export function IntegrationsView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<IntegrationRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.get<{ integrations: IntegrationRow[] }>("/api/integrations"),
  });

  const createMutation = useMutation({
    mutationFn: (body: { type: string; name: string; credentials: Record<string, string> }) =>
      api.post("/api/integrations", body),
    onSuccess: () => {
      toast({
        title: "Credentials saved",
        description: "Saved as unverified — run “Verify connection” to activate live sending.",
      });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      setShowCreate(false);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not connect",
        description: err instanceof ApiError ? err.message : "Could not connect.",
        variant: "destructive",
      }),
  });

  // Bug fix — the PATCH/DELETE endpoints existed but the UI never exposed them.
  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/api/integrations?id=${encodeURIComponent(id)}`, body),
    onSuccess: () => {
      toast({ title: "Integration updated" });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      setEditing(null);
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not update",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/integrations?id=${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast({
        title: "Integration removed",
        description: "Credentials were deleted from the server.",
      });
      qc.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (err: unknown) =>
      toast({
        title: "Could not delete",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      }),
  });

  // RECHECK FIX (G): the verify action — a REAL provider connectivity check
  // that promotes SAVED_UNVERIFIED → VERIFIED (or honestly drops to ERROR).
  const verifyMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{
        ok: boolean;
        detail: string | null;
        integration: { status: string; lastError: string | null };
      }>(`/api/integrations/verify?id=${encodeURIComponent(id)}`, {}),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast({
        title: res.ok ? "Connection verified" : "Verification failed",
        description:
          res.detail ??
          (res.ok
            ? "Credentials work against the live provider."
            : (res.integration.lastError ?? "Check the credentials and try again.")),
        variant: res.ok ? "default" : "destructive",
      });
    },
    onError: (err: unknown) => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast({
        title: "Verification failed",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const integrations = data?.integrations ?? [];
  const anyVerifyPending = verifyMutation.isPending;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Integrations"
        description="Connect WhatsApp, SMS and payment providers with your OWN credentials. Credentials are saved encrypted and must pass a real connection check before live sending."
        action={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Connect Integration
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : integrations.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No integrations connected"
          description="Connect your providers here. Save your credentials, then run Verify connection — only VERIFIED integrations are used for real sends."
          action={
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Connect First Integration
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Integration</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Last Sync</TableHead>
                  <TableHead className="hidden lg:table-cell">Notes</TableHead>
                  <TableHead className="w-[60px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {integrations.map((i) => (
                  <TableRow key={i.id} className={i.enabled ? "" : "opacity-60"}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {i.name}
                        {!i.enabled && (
                          <Badge
                            variant="outline"
                            className="text-[9.5px] px-1.5 py-0 text-muted-foreground"
                          >
                            Disabled
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{INTEGRATION_TYPES[i.type] ?? i.type}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge className={STATUS_TONES[i.status]}>{i.status}</Badge>
                        {!i.hasCredentials && (
                          <span
                            className="text-[10.5px] text-amber-600"
                            title="No credentials saved yet"
                          >
                            no creds
                          </span>
                        )}
                      </div>
                      {/* RECHECK FIX (G): distinct, honest states — saved ≠ verified. */}
                      {i.hasCredentials && i.status === "SAVED_UNVERIFIED" && (
                        <span className="mt-0.5 block text-[10px] text-amber-600">
                          saved — verify to enable live sends
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                      {i.lastSyncAt ? formatDateTime(i.lastSyncAt) : "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-rose-600">
                      {i.lastError ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {hasVerifier(i.type) && i.hasCredentials && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2.5 text-xs"
                            disabled={anyVerifyPending}
                            onClick={() => verifyMutation.mutate(i.id)}
                            aria-label={`Verify ${i.name}`}
                          >
                            {verifyMutation.isPending && verifyMutation.variables === i.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1 hidden sm:inline">Verify</span>
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`Actions for ${i.name}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onClick={() => setEditing(i)}>
                              <Pencil className="h-4 w-4" /> Edit name / rotate keys
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                patchMutation.mutate({ id: i.id, body: { enabled: !i.enabled } })
                              }
                            >
                              {i.enabled ? (
                                <>
                                  <PowerOff className="h-4 w-4" /> Disable
                                </>
                              ) : (
                                <>
                                  <Power className="h-4 w-4" /> Enable
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete "${i.name}"? Stored credentials will be removed permanently.`,
                                  )
                                ) {
                                  deleteMutation.mutate(i.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateIntegrationDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onSubmit={(body) => createMutation.mutate(body)}
        loading={createMutation.isPending}
      />

      {editing && (
        <EditIntegrationDialog
          integration={editing}
          loading={patchMutation.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(body) => patchMutation.mutate({ id: editing.id, body })}
        />
      )}
    </div>
  );
}

function EditIntegrationDialog({
  integration,
  loading,
  onClose,
  onSubmit,
}: {
  integration: IntegrationRow;
  loading: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(integration.name);
  const [enabled, setEnabled] = useState(integration.enabled);
  // RECHECK FIX (G): provider-specific rotation fields (correct key names).
  const fields = useMemo(() => fieldsFor(integration.type), [integration.type]);
  const [values, setValues] = useState<Record<string, string>>({});
  const hasSecret = Object.values(values).some((v) => v.trim().length > 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit integration</DialogTitle>
          <DialogDescription>
            {INTEGRATION_TYPES[integration.type] ?? integration.type} — credentials stay encrypted
            at rest. Leave fields empty to keep the current ones. Rotated credentials must be
            verified again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label>
                {f.label} {integration.hasCredentials ? "(optional)" : ""}
              </Label>
              <Input
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={integration.hasCredentials ? "Keep current" : f.placeholder}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
              />
              {f.hint ? <p className="text-[11px] text-muted-foreground">{f.hint}</p> : null}
            </div>
          ))}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-[13px] font-medium">Enabled</p>
              <p className="text-[11.5px] text-muted-foreground">
                A disabled integration BLOCKS its channel — messages fail honestly instead of going
                through the platform.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Toggle integration enabled"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={loading || (!name.trim() && !hasSecret && enabled === integration.enabled)}
            onClick={() =>
              onSubmit({
                ...(name.trim() && name !== integration.name ? { name: name.trim() } : {}),
                ...(hasSecret
                  ? {
                      credentials: Object.fromEntries(
                        Object.entries(values).filter(([, v]) => v.trim().length > 0),
                      ),
                    }
                  : {}),
                ...(enabled !== integration.enabled ? { enabled } : {}),
              })
            }
          >
            {loading ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4 mr-1.5" />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateIntegrationDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (body: { type: string; name: string; credentials: Record<string, string> }) => void;
  loading: boolean;
}) {
  const [type, setType] = useState("WHATSAPP_CLOUD");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = useMemo(() => fieldsFor(type), [type]);
  const requiredFilled = fields.every((f) => (values[f.key] ?? "").trim().length > 0);

  function submit() {
    onSubmit({
      type,
      name,
      credentials: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onOpenChange(false);
          setValues({});
          setName("");
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Integration</DialogTitle>
          <DialogDescription>
            Credentials are stored encrypted at rest and never exposed to the frontend. Save first,
            then run “Verify connection” to activate live sending.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v);
                setValues({});
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(INTEGRATION_TYPES).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Display Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="WhatsApp Cloud — Grand Palace"
            />
          </div>
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label>{f.label}</Label>
              <Input
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
              />
              {f.hint ? <p className="text-[11px] text-muted-foreground">{f.hint}</p> : null}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={loading || !name || !requiredFilled}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Save credentials
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
