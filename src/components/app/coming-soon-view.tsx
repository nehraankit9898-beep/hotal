"use client";

import type { ViewId } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";

const COMING_SOON: Record<
  string,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    tagline: string;
    points: string[];
  }
> = {
  leaderboard: {
    icon: ({ className }: { className?: string }) => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
        <path d="M4 22h16" />
        <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
        <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
      </svg>
    ),
    title: "Guest Leaderboard",
    tagline: "Celebrate your most loyal guests and motivate the team.",
    points: [
      "Top guests by visit count and recency",
      "Staff-friendly hall-of-fame view",
      "Exclusive offers for VIP regulars",
    ],
  },
  campaigns: {
    icon: ({ className }: { className?: string }) => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d="M14.5 3v17.55a1 1 0 0 1-1.65.76L8 17h-3a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3l4.85-4.31a1 1 0 0 1 1.65.76Z" />
        <path d="M18 8a4 4 0 0 1 0 8" />
      </svg>
    ),
    title: "Automated Campaigns",
    tagline: "Win back guests who haven't returned — automatically.",
    points: [
      "10-day win-back journeys via WhatsApp / SMS",
      "Consent-checked before every single send",
      "Smart timing based on visit patterns",
    ],
  },
  analytics: {
    icon: ({ className }: { className?: string }) => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </svg>
    ),
    title: "Advanced Analytics",
    tagline: "Understand exactly what drives repeat business.",
    points: [
      "Retention cohorts and churn prediction",
      "Visit-gap and seasonality insights",
      "Campaign ROI measurement",
    ],
  },
};

export function ComingSoonView({ view }: { view: ViewId }) {
  const cfg = COMING_SOON[view] ?? COMING_SOON.leaderboard;
  const Icon = cfg.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-center py-8"
    >
      <Card className="w-full max-w-xl overflow-hidden">
        <div className="brand-pattern h-36 bg-[linear-gradient(130deg,oklch(0.96_0.03_75),oklch(0.93_0.05_65))] dark:bg-[linear-gradient(130deg,oklch(0.26_0.04_55),oklch(0.3_0.05_50))] relative">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-background/85 backdrop-blur border shadow-lg text-primary">
              <Icon className="h-10 w-10" />
            </div>
          </div>
          <Badge className="absolute top-4 right-4 bg-background/85 backdrop-blur border text-primary hover:bg-background/85">
            Coming in Phase 2
          </Badge>
        </div>
        <CardContent className="p-8 text-center">
          <h2 className="text-xl font-bold tracking-tight">{cfg.title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{cfg.tagline}</p>

          <div className="mt-6 space-y-2.5 text-left max-w-sm mx-auto">
            {cfg.points.map((p) => (
              <div
                key={p}
                className="flex items-start gap-2.5 rounded-lg border bg-accent/30 px-3.5 py-2.5"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <p className="text-[13px]">{p}</p>
              </div>
            ))}
          </div>

          <p className="mt-6 text-xs text-muted-foreground leading-relaxed max-w-md mx-auto">
            Your Phase 1 data — customers, visits, and consent — is already being collected in a way
            these features will use directly. Nothing will need to be re-entered.
          </p>

          <div className="mt-6 flex justify-center gap-2">
            <Button variant="outline" size="sm" disabled className="opacity-60 cursor-not-allowed">
              Notify me at launch
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
