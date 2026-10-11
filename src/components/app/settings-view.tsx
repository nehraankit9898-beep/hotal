"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser, SettingsResponse } from "@/lib/types";
import { ROLE_LABELS } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { UserCog, Lock, Building2, Loader2, CheckCircle2, ShieldCheck, Rocket } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { MfaCard } from "@/components/app/mfa-card";

export function SettingsView({ user }: { user: SessionUser }) {
  // Phase 2: session restricted until the password is changed.
  const forced = user.mustChangePassword === true;
  // Phase 8.1 §3: hotel-scoped sections are NEVER rendered for SUPER_ADMIN —
  // hotel settings (frequency/consent/feedback) belong to hotel roles only.
  const isSuperAdmin = user.role === "SUPER_ADMIN";

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // profile form
  const [name, setName] = useState(user.name);
  const [profileError, setProfileError] = useState<string | null>(null);

  // password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  const profileMutation = useMutation({
    mutationFn: () => api.patch("/api/profile", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({ title: "Profile updated", description: "Your name has been saved." });
    },
    onError: (err) => {
      setProfileError(err instanceof ApiError ? err.message : "Could not update profile.");
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () => api.patch("/api/profile", { currentPassword, newPassword }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: "Password changed",
        description: "Use your new password next time you sign in.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwError(null);
    },
    onError: (err) => {
      setPwError(err instanceof ApiError ? err.message : "Could not change password.");
    },
  });

  function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    profileMutation.mutate();
  }

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    passwordMutation.mutate();
  }

  return (
    <div className="max-w-3xl space-y-5">
      {forced && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 mb-4">
          <ShieldCheck className="h-4 w-4" />
          <AlertDescription className="text-amber-900">
            For security you must set a new password before you can use StayLoop. Choose a strong
            password below — after saving, sign in again.
          </AlertDescription>
        </Alert>
      )}
      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <UserCog className="h-4 w-4 text-primary" /> Your profile
          </CardTitle>
          <CardDescription>Update how your name appears across the app.</CardDescription>
        </CardHeader>
        <CardContent>
          {profileError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{profileError}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handleProfileSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="s-name">Full name</Label>
                <Input
                  id="s-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="s-email">Email (sign-in ID)</Label>
                <Input id="s-email" value={user.email} disabled className="bg-muted/60" />
                <p className="text-[11px] text-muted-foreground">
                  Your email cannot be changed in Phase 1.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-primary/40 bg-primary/5 text-primary">
                {ROLE_LABELS[user.role] ?? user.role}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {isSuperAdmin
                  ? "Platform operator — you manage hotels, plans and platform health."
                  : user.role === "HOTEL_ADMIN" || user.role === "HOTEL_OWNER"
                    ? "Full access to all features and audit logs."
                    : "Scoped access per your role — see the sidebar."}
              </span>
            </div>
            <Button type="submit" disabled={profileMutation.isPending || name === user.name}>
              {profileMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                "Save profile"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Phase 10 — TOTP MFA (available to EVERY account; mandatory per policy) */}
      <MfaCard user={user} />

      {/* Password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <Lock className="h-4 w-4 text-primary" /> Change password
          </CardTitle>
          <CardDescription>
            Use a strong password with at least 8 characters and a number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pwError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{pwError}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pw-current">Current password</Label>
                <Input
                  id="pw-current"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pw-new">New password</Label>
                <Input
                  id="pw-new"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pw-confirm">Confirm new password</Label>
                <Input
                  id="pw-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
            </div>
            <Button type="submit" disabled={passwordMutation.isPending}>
              {passwordMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Updating…
                </>
              ) : (
                "Update password"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Hotel info — hotel roles only (Phase 8.1 §3) */}
      {!isSuperAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <Building2 className="h-4 w-4 text-primary" /> Your hotel
            </CardTitle>
            <CardDescription>Hotel details are managed by StayLoop during Phase 1.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div className="flex items-center gap-2.5">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Hotel:</span>
                <span className="font-semibold">{user.hotelName}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Status:</span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/40 text-emerald-600 bg-emerald-500/5"
                >
                  Active
                </Badge>
              </div>
            </div>
            <Separator className="my-4" />
            <div className="flex items-start gap-2.5 rounded-lg bg-accent/40 p-3.5">
              <ShieldCheck className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground">Privacy guarantee:</span> your
                guests&apos; data belongs to your hotel only. Every query in StayLoop is scoped to
                your hotel ID — other hotels can never see or access your customers, visits, or
                audit logs.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Phase 6.3 — Marketing safety & customer experience (hotel roles only) */}
      {!isSuperAdmin && <MarketingSafetyCard user={user} />}

      {/* Roadmap — hotel roles only */}
      {!isSuperAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[15px]">
              <Rocket className="h-4 w-4 text-primary" /> What&apos;s coming in Phase 2
            </CardTitle>
            <CardDescription>Your Phase 1 data is already prepared for these.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {[
                "Guest Leaderboard — spotlight your most loyal visitors",
                "Automated Campaigns — 10-day win-back journeys via WhatsApp/SMS",
                "Advanced Analytics — retention cohorts, churn prediction, campaign ROI",
                "Discount engine & loyalty points",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2.5 text-[13px]">
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Phase 6.3 — Marketing frequency control + consent text + feedback toggle.
 * Settings are enforced by the BACKEND send pipeline; this UI is the control panel.
 */
function MarketingSafetyCard({ user }: { user: SessionUser }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["restaurant-settings"],
    queryFn: () => api.get<SettingsResponse>("/api/settings"),
  });

  const canManage = user.role === "HOTEL_ADMIN" || user.role === "HOTEL_OWNER";

  const feedbackSave = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/settings", body),
    onSuccess: () => {
      toast({ title: "Saved" });
      qc.invalidateQueries({ queryKey: ["restaurant-settings"] });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not save",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <ShieldCheck className="h-4 w-4 text-primary" /> Marketing safety (Phase 6.3)
          </CardTitle>
          <CardDescription>Loading settings…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ShieldCheck className="h-4 w-4 text-primary" /> Marketing safety (Phase 6.3)
        </CardTitle>
        <CardDescription>
          Anti-spam protections enforced by the backend on every campaign send.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Keyed by current server values: the form remounts with fresh state
            whenever saved settings change — no effect-based syncing needed. */}
        <MarketingSafetyForm
          key={`${data.settings.marketingFrequencyLimit}-${data.settings.frequencyWindowDays}-${data.settings.consentText}`}
          settings={data.settings}
          canManage={canManage}
        />

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Allow feedback on QR page</p>
            <p className="text-xs text-muted-foreground">
              Customers can rate their experience from your QR codes.
            </p>
          </div>
          <Switch
            checked={data.settings.feedbackEnabled}
            onCheckedChange={(v) => {
              if (!canManage) return;
              feedbackSave.mutate({ feedbackEnabled: v });
            }}
            disabled={!canManage || feedbackSave.isPending}
          />
        </div>

        {!canManage ? (
          <p className="text-xs text-muted-foreground">
            Only hotel admins can change these settings.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MarketingSafetyForm({
  settings,
  canManage,
}: {
  settings: SettingsResponse["settings"];
  canManage: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [freq, setFreq] = useState(String(settings.marketingFrequencyLimit));
  const [windowDays, setWindowDays] = useState(String(settings.frequencyWindowDays));
  const [consentText, setConsentText] = useState(settings.consentText);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/api/settings", body),
    onSuccess: () => {
      toast({ title: "Marketing settings saved" });
      qc.invalidateQueries({ queryKey: ["restaurant-settings"] });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not save",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="ms-freq">Max messages per customer</Label>
          <Input
            id="ms-freq"
            type="number"
            min={1}
            max={50}
            value={freq}
            onChange={(e) => setFreq(e.target.value)}
            disabled={!canManage}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ms-window">Window (days)</Label>
          <Input
            id="ms-window"
            type="number"
            min={1}
            max={365}
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
            disabled={!canManage}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Example: 3 messages / 30 days means no customer receives more than 3 marketing messages in
        any 30-day period — even if you run more campaigns. Opted-out customers are always excluded
        first.
      </p>

      <div className="space-y-2">
        <Label htmlFor="ms-consent">Consent text shown on your QR join page</Label>
        <Textarea
          id="ms-consent"
          rows={2}
          value={consentText}
          onChange={(e) => setConsentText(e.target.value)}
          disabled={!canManage}
        />
      </div>

      {canManage ? (
        <Button
          disabled={save.isPending || !freq || !windowDays}
          onClick={() =>
            save.mutate({
              marketingFrequencyLimit: Number(freq),
              frequencyWindowDays: Number(windowDays),
              ...(consentText !== settings.consentText ? { consentText } : {}),
            })
          }
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save marketing
          settings
        </Button>
      ) : null}
    </div>
  );
}
