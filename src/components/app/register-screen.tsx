"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { api, ApiError } from "@/lib/api-client";
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
  User,
  MapPin,
  Phone,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";

export function RegisterScreen({ onGoLogin }: { onGoLogin: () => void }) {
  const [form, setForm] = useState({
    hotelName: "",
    location: "",
    hotelPhone: "",
    adminName: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError("Passwords do not match. Please re-enter them.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/hotels", {
        hotelName: form.hotelName,
        location: form.location,
        hotelPhone: form.hotelPhone,
        adminName: form.adminName,
        email: form.email,
        password: form.password,
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not register your hotel. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm"
        >
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-bold">Hotel registered!</h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">{form.hotelName}</span> is ready. You can
            now sign in with <span className="font-medium">{form.email}</span>.
          </p>
          <Button className="mt-6 w-full h-11" onClick={onGoLogin}>
            Continue to sign in
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[linear-gradient(180deg,oklch(0.975_0.01_85)_0%,oklch(0.955_0.02_80)_100%)] p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-lg rounded-2xl border bg-card p-7 sm:p-8 shadow-sm"
      >
        <button
          type="button"
          onClick={onGoLogin}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5"
        >
          <ArrowLeft className="h-4 w-4" /> Back to sign in
        </button>

        <div className="flex items-center gap-3 mb-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Hotel className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Register your hotel</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Create your hotel&apos;s workspace in under a minute. You&apos;ll be the first admin.
        </p>

        {error && (
          <Alert variant="destructive" className="mb-5">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="hotelName">Hotel name *</Label>
              <div className="relative">
                <Hotel className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="hotelName"
                  placeholder="e.g. Sunrise Grand Hotel"
                  className="pl-10 h-11"
                  value={form.hotelName}
                  onChange={(e) => set("hotelName", e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location">City / location</Label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="location"
                  placeholder="Mumbai"
                  className="pl-10 h-11"
                  value={form.location}
                  onChange={(e) => set("location", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="hotelPhone">Hotel phone</Label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="hotelPhone"
                  placeholder="+91 98765 43210"
                  className="pl-10 h-11"
                  value={form.hotelPhone}
                  onChange={(e) => set("hotelPhone", e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adminName">Your full name *</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="adminName"
                  placeholder="e.g. Arjun Mehta"
                  className="pl-10 h-11"
                  value={form.adminName}
                  onChange={(e) => set("adminName", e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="reg-email">Work email *</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="reg-email"
                  type="email"
                  placeholder="you@yourhotel.com"
                  className="pl-10 h-11"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reg-password">Password *</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="reg-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Min 8 chars, 1 number"
                  className="pl-10 pr-10 h-11"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
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

            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password *</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="confirm"
                  type={showPassword ? "text" : "password"}
                  placeholder="Repeat password"
                  className="pl-10 h-11"
                  value={form.confirm}
                  onChange={(e) => set("confirm", e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          <Button type="submit" className="w-full h-11 text-[15px]" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Creating your workspace…
              </>
            ) : (
              "Create hotel workspace"
            )}
          </Button>

          <p className="text-[11px] text-center text-muted-foreground leading-relaxed">
            By registering you agree to record guest marketing consent honestly. Guests can opt out
            at any time — RestroLoop enforces it automatically.
          </p>
        </form>
      </motion.div>
    </div>
  );
}
