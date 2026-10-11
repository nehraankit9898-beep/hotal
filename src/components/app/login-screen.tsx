"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { api, ApiError, storeSessionToken } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Hotel,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
  Repeat,
  BellRing,
  BarChart3,
  ShieldCheck,
  Building2,
  ArrowRight,
  ShieldCheck as PlatformIcon,
  KeyRound,
  ArrowLeft,
} from "lucide-react";

export function LoginScreen({
  onLoggedIn,
  onGoRegister,
}: {
  onLoggedIn: () => void;
  onGoRegister: () => void;
}) {
  const [mode, setMode] = useState<"hotel" | "platform">("hotel");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Phase 10 — TOTP MFA challenge state (after correct password)
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "platform") {
        // Platform Super Admin — dedicated login path (Phase 6)
        const res = await api.post<{
          token?: string;
          sessionToken?: string;
          mfaRequired?: boolean;
          mfaToken?: string;
        }>("/api/super-admin/login", { email, password });
        if (res.mfaRequired && res.mfaToken) {
          setMfaToken(res.mfaToken);
          return;
        }
        const token = res.token ?? res.sessionToken;
        if (token) storeSessionToken(token);
      } else {
        const res = await api.post<{
          sessionToken?: string;
          mfaRequired?: boolean;
          mfaToken?: string;
        }>("/api/auth/login", { email, password });
        if (res.mfaRequired && res.mfaToken) {
          setMfaToken(res.mfaToken);
          return;
        }
        // Persist the fallback token for contexts where cookies are blocked
        // (cross-site iframe embedding). Cookie remains the primary session.
        if (res.sessionToken) storeSessionToken(res.sessionToken);
      }
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign you in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ sessionToken?: string }>("/api/auth/mfa/verify", {
        mfaToken,
        code: mfaCode,
      });
      if (res.sessionToken) storeSessionToken(res.sessionToken);
      setMfaToken(null);
      setMfaCode("");
      onLoggedIn();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Invalid authentication code. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setMfaToken(null);
    setMfaCode("");
    setError(null);
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background">
      {/* Brand panel */}
      <div className="relative hidden lg:flex lg:w-[46%] flex-col justify-between overflow-hidden bg-[linear-gradient(150deg,#7c2d12_0%,#92400e_35%,#b45309_70%,#d97706_100%)] text-amber-50 p-10 xl:p-14">
        <div className="brand-pattern absolute inset-0 pointer-events-none" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 backdrop-blur border border-white/20">
              <Hotel className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xl font-bold tracking-tight">RestroLoop</p>
              <p className="text-xs text-amber-100/80">Hotel Customer Retention</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-md">
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-4xl xl:text-[2.75rem] font-bold leading-tight tracking-tight"
          >
            Turn one-time guests into loyal regulars.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mt-4 text-amber-100/90 text-base leading-relaxed"
          >
            Know every guest who walks through your doors. Track visits, record consent the right
            way, and watch your repeat-customer rate climb — all in one simple dashboard.
          </motion.p>

          <div className="mt-8 space-y-4">
            {[
              { icon: Repeat, text: "Automatic visit tracking & guest history" },
              { icon: BellRing, text: "Consent-first marketing (GDPR-friendly)" },
              { icon: BarChart3, text: "Real retention insights, live from your data" },
              { icon: ShieldCheck, text: "Bank-grade security, per-hotel privacy" },
            ].map((f, i) => (
              <motion.div
                key={f.text}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.1 }}
                className="flex items-center gap-3"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/12 border border-white/15">
                  <f.icon className="h-4 w-4" />
                </div>
                <p className="text-sm text-amber-50/95">{f.text}</p>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="relative text-xs text-amber-100/70">
          © {new Date().getFullYear()} RestroLoop · Restaurant CRM & Ordering
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-md"
        >
          {/* Mobile logo */}
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
              <Hotel className="h-7 w-7" />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold tracking-tight">RestroLoop</h1>
              <p className="text-xs text-muted-foreground">Hotel Customer Retention</p>
            </div>
          </div>

          <div className="mb-7">
            <h2 className="text-2xl font-bold tracking-tight">
              {mode === "platform" ? "Platform admin" : "Welcome back"}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {mode === "platform"
                ? "Sign in to the multi-hotel platform control centre."
                : "Sign in to manage your hotel's guests and visits."}
            </p>
          </div>

          {/* Mode switch — Hotel vs Platform Super Admin */}
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "hotel"}
              onClick={() => {
                setMode("hotel");
                setError(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                mode === "hotel"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Hotel className="h-3.5 w-3.5" /> Hotel sign-in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "platform"}
              onClick={() => {
                setMode("platform");
                setError(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                mode === "platform"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <PlatformIcon className="h-3.5 w-3.5" /> Platform admin
            </button>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-5">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {mfaToken ? (
            <form onSubmit={handleMfaVerify} className="space-y-4">
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <KeyRound className="h-4 w-4" /> Two-factor authentication
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter the 6-digit code from your authenticator app, or one of your single-use
                  backup codes.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mfa-code">Authentication code</Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="••••••"
                  className="h-11 text-center text-lg tracking-[0.4em] font-mono"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\s/g, ""))}
                  maxLength={10}
                  autoFocus
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full h-11 text-[15px]"
                disabled={loading || mfaCode.length < 6}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                  </>
                ) : (
                  <>
                    Verify and sign in <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={backToPassword}
                className="w-full text-xs text-muted-foreground hover:text-foreground flex items-center justify-center gap-1"
              >
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email address</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@yourhotel.com"
                    className="pl-10 h-11"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    className="pl-10 pr-10 h-11"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full h-11 text-[15px]" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Signing you in…
                  </>
                ) : (
                  <>
                    {mode === "platform" ? "Sign in as super admin" : "Sign in"}{" "}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </form>
          )}

          {/* Security notice (Phase 2): demo credentials removed from the UI */}
          <div className="mt-7 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4 text-xs text-muted-foreground">
            Sign in with the account created for your hotel. Demo credentials are no longer embedded
            in the application — hotel owners receive a one-time invitation link, and platform super
            admins are provisioned through a secure bootstrap process.
          </div>

          {mode === "hotel" && (
            <p className="mt-6 text-center text-sm text-muted-foreground">
              New hotel?{" "}
              <button
                type="button"
                onClick={onGoRegister}
                className="font-semibold text-primary hover:underline underline-offset-4"
              >
                <Building2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                Register your hotel
              </button>
            </p>
          )}
        </motion.div>
      </div>
    </div>
  );
}
