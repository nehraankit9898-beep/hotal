"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { SessionUser } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2, ShieldCheck, Copy, CheckCircle2 } from "lucide-react";

/**
 * MFA management card — Phase 10 §14.
 *
 * Full TOTP lifecycle for the signed-in user:
 *  - status (enabled? backup codes remaining?)
 *  - setup (QR + secret shown ONCE)
 *  - enable (verify first live code → backup codes returned ONCE)
 *  - disable (requires a fresh code)
 *  - regenerate backup codes (requires a fresh code)
 *
 * Works for every role; when the platform MFA policy requires the user's
 * role (e.g. SUPER_ADMIN), the banner explains enrolment is mandatory and
 * the server restricts the session until enabled.
 */
export function MfaCard({ user }: { user: SessionUser }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["mfa", "status"],
    queryFn: () =>
      api.get<{ mfaEnabled: boolean; backupCodesRemaining: number; mfaSetupRequired: boolean }>(
        "/api/mfa",
      ),
  });

  const [setupDialog, setSetupDialog] = useState(false);
  const [disableDialog, setDisableDialog] = useState(false);
  const [regenDialog, setRegenDialog] = useState(false);
  const [code, setCode] = useState("");
  const [setupData, setSetupData] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const setup = useMutation({
    mutationFn: () =>
      api.post<{ qrDataUrl: string; secret: string; otpauthUrl: string }>("/api/mfa/setup", {}),
    onSuccess: (res) => {
      setSetupData({ qrDataUrl: res.qrDataUrl, secret: res.secret });
      setSetupDialog(true);
    },
    onError: (err) =>
      toast({
        title: "Could not start MFA setup",
        description: err instanceof ApiError ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const enable = useMutation({
    mutationFn: () => api.post<{ backupCodes: string[] }>("/api/mfa/enable", { code }),
    onSuccess: (res) => {
      setBackupCodes(res.backupCodes);
      setSetupDialog(false);
      setCode("");
      setSetupData(null);
      queryClient.invalidateQueries({ queryKey: ["mfa", "status"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) =>
      toast({
        title: "Verification failed",
        description: err instanceof ApiError ? err.message : "Check the code and try again.",
        variant: "destructive",
      }),
  });

  const disable = useMutation({
    mutationFn: () => api.post("/api/mfa/disable", { code }),
    onSuccess: () => {
      setDisableDialog(false);
      setCode("");
      toast({ title: "MFA disabled", description: "Re-enable it any time from this page." });
      queryClient.invalidateQueries({ queryKey: ["mfa", "status"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) =>
      toast({
        title: "Could not disable MFA",
        description: err instanceof ApiError ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ backupCodes: string[] }>("/api/mfa/backup-codes", { code }),
    onSuccess: (res) => {
      setBackupCodes(res.backupCodes);
      setRegenDialog(false);
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["mfa", "status"] });
    },
    onError: (err) =>
      toast({
        title: "Could not regenerate codes",
        description: err instanceof ApiError ? err.message : undefined,
        variant: "destructive",
      }),
  });

  function copyCodes() {
    if (backupCodes) {
      void navigator.clipboard.writeText(backupCodes.join("\n"));
      toast({ title: "Backup codes copied" });
    }
  }

  const enabled = statusQuery.data?.mfaEnabled ?? false;
  const required = user.mfaSetupRequired === true || (statusQuery.data?.mfaSetupRequired ?? false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <KeyRound className="h-4 w-4 text-primary" /> Multi-factor authentication
          {enabled ? (
            <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30">
              Enabled
            </Badge>
          ) : required ? (
            <Badge variant="destructive">Required — set up now</Badge>
          ) : (
            <Badge variant="secondary">Not set up</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Time-based one-time passwords (TOTP) via Google Authenticator, Authy or any RFC 6238 app.
          {user.role === "SUPER_ADMIN" && " MFA is mandatory for super admin accounts."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {required && !enabled && (
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertDescription>
              Your platform policy requires MFA for your role. Until you enrol, the rest of the
              platform is locked (server-enforced) — set it up below.
            </AlertDescription>
          </Alert>
        )}
        {enabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              Backup codes remaining: <b>{statusQuery.data?.backupCodesRemaining ?? 0}</b> (each is
              single-use and can sign you in if you lose your authenticator).
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setRegenDialog(true)}>
                <Copy className="h-4 w-4 mr-1.5" /> Regenerate backup codes
              </Button>
              <Button
                variant="outline"
                className="text-rose-600"
                onClick={() => setDisableDialog(true)}
              >
                Disable MFA
              </Button>
            </div>
          </>
        ) : (
          <Button onClick={() => setup.mutate()} disabled={setup.isPending}>
            {setup.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <KeyRound className="h-4 w-4 mr-1.5" />
            )}
            Set up authenticator
          </Button>
        )}

        {/* Setup dialog: QR + secret + verify code */}
        <Dialog
          open={setupDialog}
          onOpenChange={(o) => {
            if (!o && !enable.isPending) {
              setSetupDialog(false);
              setSetupData(null);
              setCode("");
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set up your authenticator</DialogTitle>
              <DialogDescription>
                Scan the QR code with your authenticator app (or enter the secret manually), then
                confirm with the 6-digit code it shows.
              </DialogDescription>
            </DialogHeader>
            {setupData && (
              <div className="space-y-4">
                <div className="flex justify-center rounded-xl border bg-white p-3">
                  <img src={setupData.qrDataUrl} alt="TOTP QR code" width={220} height={220} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Manual secret (shown once)</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={setupData.secret} className="font-mono text-xs h-9" />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(setupData.secret);
                        toast({ title: "Secret copied" });
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Enter the 6-digit code from your app</Label>
                  <Input
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="h-11 text-center text-lg tracking-[0.4em] font-mono"
                    placeholder="••••••"
                    autoFocus
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setSetupDialog(false);
                  setSetupData(null);
                  setCode("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => enable.mutate()}
                disabled={enable.isPending || code.length !== 6}
              >
                {enable.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-1.5" />
                )}
                Verify &amp; enable
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Backup codes reveal dialog */}
        <Dialog open={backupCodes !== null} onOpenChange={(o) => !o && setBackupCodes(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" /> Save your backup codes
              </DialogTitle>
              <DialogDescription>
                Each code works exactly ONCE if you lose your authenticator. They are shown only
                this once — store them somewhere safe.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
              {(backupCodes ?? []).map((c) => (
                <span key={c} className="text-center tracking-wider">
                  {c}
                </span>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={copyCodes}>
                <Copy className="h-4 w-4 mr-1.5" /> Copy all
              </Button>
              <Button onClick={() => setBackupCodes(null)}>I saved them</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Disable dialog */}
        <Dialog open={disableDialog} onOpenChange={setDisableDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disable MFA</DialogTitle>
              <DialogDescription>
                Enter a current authentication code to confirm. A stolen session alone cannot remove
                your second factor.
              </DialogDescription>
            </DialogHeader>
            <Input
              inputMode="numeric"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              className="h-11 text-center text-lg tracking-[0.3em] font-mono"
              placeholder="6-digit code or backup code"
              autoFocus
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setDisableDialog(false);
                  setCode("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => disable.mutate()}
                disabled={disable.isPending || code.length < 6}
              >
                {disable.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Disable MFA
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Regenerate dialog */}
        <Dialog open={regenDialog} onOpenChange={setRegenDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Regenerate backup codes</DialogTitle>
              <DialogDescription>
                All existing backup codes will be invalidated. Enter a current code to confirm.
              </DialogDescription>
            </DialogHeader>
            <Input
              inputMode="numeric"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              className="h-11 text-center text-lg tracking-[0.3em] font-mono"
              placeholder="6-digit code or backup code"
              autoFocus
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setRegenDialog(false);
                  setCode("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending || code.length < 6}
              >
                {regenerate.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Regenerate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
