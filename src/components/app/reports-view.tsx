"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading, StatCard } from "@/components/app/shared-ui";
import { BarChart3, Mail } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

interface SalesReport {
  date: string;
  timezone: string;
  bills: { count: number; grossMinor: number; discountMinor: number; netSalesMinor: number; taxMinor: number; refundMinor: number };
  payments: { byMethod: Record<string, number>; bySource: { gatewayVerified: number; manuallyRecorded: number } };
}
interface Schedule {
  frequency: string;
  weekday: number | null;
  hour: number;
  recipients: string;
  active: boolean;
  lastSentAt: string | null;
  lastResult: string | null;
}

/** Phase 15 — owner reports + email digest schedule. */
export function ReportsView() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState("");
  const [recipients, setRecipients] = useState("");
  const [frequency, setFrequency] = useState("DAILY");

  const reportQ = useQuery({
    queryKey: ["sales-report", date],
    queryFn: async () => (await api.get(`/api/reports/sales${date ? `?date=${date}` : ""}`)) as SalesReport,
  });
  const scheduleQ = useQuery({
    queryKey: ["report-schedule"],
    queryFn: async () => (await api.get("/api/report-schedule")) as { schedule: Schedule },
  });

  const saveSchedule = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => (await api.put("/api/report-schedule", patch)) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Report schedule saved.");
      queryClient.invalidateQueries({ queryKey: ["report-schedule"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const schedule = scheduleQ.data?.schedule;
  const r = reportQ.data;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Owner reports"
        description="Business-day figures reconcile against invoices, payment allocations and refunds — tenant timezone aware."
        action={<Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard title="Bills" value={r?.bills.count ?? 0} icon={BarChart3} />
        <StatCard title="Net sales" value={rupees(r?.bills.netSalesMinor ?? 0)} icon={BarChart3} tone="emerald" />
        <StatCard title="Tax collected" value={rupees(r?.bills.taxMinor ?? 0)} icon={BarChart3} tone="amber" />
        <StatCard title="Refunds" value={rupees(r?.bills.refundMinor ?? 0)} icon={BarChart3} tone="rose" />
      </div>

      <Card>
        <CardContent className="p-4 space-y-2 text-sm">
          <div className="font-semibold">Payment modes ({r?.timezone ?? ""})</div>
          {Object.entries(r?.payments.byMethod ?? {}).length === 0 ? (
            <p className="text-muted-foreground">No payments recorded for this business day yet.</p>
          ) : (
            Object.entries(r?.payments.byMethod ?? {}).map(([m, v]) => (
              <div key={m} className="flex justify-between border-b py-1">
                <span>{m}</span><span>{rupees(v)}</span>
              </div>
            ))
          )}
          <p className="text-xs text-muted-foreground">
            {r?.payments.bySource.gatewayVerified ?? 0} gateway-verified · {r?.payments.bySource.manuallyRecorded ?? 0} manually recorded
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="font-semibold text-sm flex items-center gap-2"><Mail className="h-4 w-4" /> Email digest</div>
          {schedule && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Switch
                checked={schedule.active}
                onCheckedChange={(v) => saveSchedule.mutate({ frequency: schedule.frequency, weekday: schedule.weekday, hour: schedule.hour, recipients: JSON.parse(schedule.recipients || "[]"), active: v })}
              />
              <Select value={frequency || schedule.frequency} onValueChange={setFrequency}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAILY">Daily</SelectItem>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="flex-1 min-w-64"
                placeholder="owner@example.com, manager@example.com"
                defaultValue={(JSON.parse(schedule.recipients || "[]") as string[]).join(", ")}
                onChange={(e) => setRecipients(e.target.value)}
              />
              <Button
                disabled={saveSchedule.isPending}
                onClick={() =>
                  saveSchedule.mutate({
                    frequency: frequency || schedule.frequency,
                    weekday: 1,
                    hour: schedule.hour,
                    recipients: recipients.split(",").map((s) => s.trim()).filter(Boolean),
                    active: true,
                  })
                }
              >
                Save
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {schedule?.lastResult ? `Last send: ${schedule.lastResult}` : "Digest emails fire when email transport is configured (Integrations)."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
