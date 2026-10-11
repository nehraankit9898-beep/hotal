"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { formatNumber } from "@/lib/format";

export function StatCard({
  title,
  value,
  hint,
  icon: Icon,
  tone = "default",
  delay = 0,
}: {
  title: string;
  value: number | string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "amber" | "emerald" | "rose" | "violet";
  delay?: number;
}) {
  const tones: Record<string, string> = {
    default: "bg-primary/10 text-primary",
    amber: "bg-amber-500/12 text-amber-600",
    emerald: "bg-emerald-500/12 text-emerald-600",
    rose: "bg-rose-500/12 text-rose-600",
    violet: "bg-violet-500/12 text-violet-600",
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgb(0_0_0_/_0.04)] hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-muted-foreground leading-tight">{title}</p>
          <p className="mt-2 text-[28px] font-bold tracking-tight leading-none tabular-nums">
            {typeof value === "number" ? formatNumber(value) : value}
          </p>
          {hint && <p className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</p>}
        </div>
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            tones[tone],
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </motion.div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4">
        <Icon className="h-7 w-7" />
      </div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground leading-relaxed">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div>
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}
