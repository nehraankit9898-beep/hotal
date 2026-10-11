"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Clock, LogOut, CalendarDays } from "lucide-react";

interface AttendanceRow {
  id: string;
  date: string;
  status: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  minutesWorked: number | null;
  user: { name: string; role: string };
}
interface ShiftRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  user: { name: string };
}

/** Phase 16 — staff attendance & shifts (self clock-in + owner corrections). */
export function AttendanceView() {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);

  const meQ = useQuery({
    queryKey: ["attendance-me"],
    queryFn: async () => (await api.get("/api/attendance")) as { records: AttendanceRow[] },
  });
  const shiftsQ = useQuery({
    queryKey: ["shifts", date],
    queryFn: async () => (await api.get(`/api/shifts?date=${date}`)) as { shifts: ShiftRow[] },
  });

  const clock = useMutation({
    mutationFn: async (action: "CLOCK_IN" | "CLOCK_OUT") =>
      (await api.post("/api/attendance", { action })) as Record<string, unknown>,
    onSuccess: (_d, action) => {
      toast.success(action === "CLOCK_IN" ? "Clocked in." : "Clocked out.");
      queryClient.invalidateQueries({ queryKey: ["attendance-me"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const myToday = (meQ.data?.records ?? []).find((r) => r.date === today && r.clockInAt && !r.clockOutAt);
  const records = (meQ.data?.records ?? []).filter((r) => r.date === date);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Attendance & shifts"
        description="Clock in/out from any device. Owner corrections are audited with before/after."
        action={<Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />}
      />

      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          {myToday ? (
            <>
              <Badge className="bg-emerald-600 hover:bg-emerald-600">ON SHIFT since {new Date(myToday.clockInAt!).toLocaleTimeString()}</Badge>
              <Button size="sm" variant="outline" onClick={() => clock.mutate("CLOCK_OUT")}>
                <LogOut className="h-4 w-4" /> Clock out
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => clock.mutate("CLOCK_IN")}>
              <Clock className="h-4 w-4" /> Clock in
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold text-sm mb-2">Attendance — {date}</h3>
          {records.length === 0 ? (
            <EmptyState icon={Clock} title="No records" description="Attendance for this date appears here." />
          ) : (
            <div className="space-y-1 text-sm">
              {records.map((r) => (
                <div key={r.id} className="flex items-center justify-between border-b py-1">
                  <span>{r.user.name} <span className="text-xs text-muted-foreground">{r.user.role}</span></span>
                  <span className="flex items-center gap-2">
                    {r.clockInAt && <span className="text-xs">in {new Date(r.clockInAt).toLocaleTimeString()}</span>}
                    {r.clockOutAt && <span className="text-xs">out {new Date(r.clockOutAt).toLocaleTimeString()}</span>}
                    {r.minutesWorked != null && <Badge variant="secondary">{Math.floor(r.minutesWorked / 60)}h {r.minutesWorked % 60}m</Badge>}
                    <Badge variant="outline">{r.status.replace("_", " ")}</Badge>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold text-sm mb-2 flex items-center gap-2"><CalendarDays className="h-4 w-4" /> Shifts — {date}</h3>
          {(shiftsQ.data?.shifts ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No shifts assigned.</p>
          ) : (
            <div className="space-y-1 text-sm">
              {(shiftsQ.data?.shifts ?? []).map((s) => (
                <div key={s.id} className="flex justify-between border-b py-1">
                  <span>{s.user.name}</span>
                  <span>{s.startTime} – {s.endTime}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
