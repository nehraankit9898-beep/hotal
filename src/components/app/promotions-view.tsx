"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Megaphone } from "lucide-react";

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(minor / 100);

interface Promotion {
  id: string;
  name: string;
  type: string;
  percentBps: number | null;
  valueMinor: number | null;
  daysOfWeek: string | null;
  startTime: string | null;
  endTime: string | null;
  priority: number;
  stackable: boolean;
  active: boolean;
  version: number;
}

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** Phase 15 — promotions (happy hours, combos, flat/percent offers). */
export function PromotionsView() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState("PERCENT");
  const [percent, setPercent] = useState("10");
  const [amount, setAmount] = useState("100");
  const [days, setDays] = useState<string[]>([]);
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("20:00");

  const promosQ = useQuery({
    queryKey: ["promotions"],
    queryFn: async () => (await api.get("/api/promotions")) as { promotions: Promotion[] },
  });

  const create = useMutation({
    mutationFn: async () =>
      (await api.post("/api/promotions", {
        name,
        type,
        percentBps: type === "PERCENT" ? Math.round(Number(percent) * 100) : undefined,
        valueMinor: type !== "PERCENT" ? Math.round(Number(amount) * 100) : undefined,
        daysOfWeek: days.length > 0 ? days : undefined,
        startTime: type === "HAPPY_HOUR" ? start : undefined,
        endTime: type === "HAPPY_HOUR" ? end : undefined,
      })) as { promotion: Promotion },
    onSuccess: () => {
      toast.success("Promotion created. Bills freeze the version they used.");
      setName("");
      queryClient.invalidateQueries({ queryKey: ["promotions"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggle = useMutation({
    mutationFn: async (p: Promotion) => (await api.patch(`/api/promotions/${p.id}`, { active: !p.active })) as Record<string, unknown>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["promotions"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  const describe = (p: Promotion) => {
    if (p.type === "PERCENT") return `${(p.percentBps! / 100).toFixed(2)}% off`;
    if (p.type === "COMBO") return `combo price ${rupees(p.valueMinor ?? 0)}`;
    return `flat ${rupees(p.valueMinor ?? 0)} off`;
  };

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Promotions"
        description="Server-side pricing only. Issued bills keep their promotion snapshot — edits never rewrite invoices."
      />
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input className="w-56" placeholder="Weekday happy hour" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PERCENT">Percent off</SelectItem>
                <SelectItem value="FLAT">Flat amount off</SelectItem>
                <SelectItem value="HAPPY_HOUR">Happy hour (window)</SelectItem>
                <SelectItem value="COMBO">Combo price</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "PERCENT" || type === "HAPPY_HOUR" ? (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">% off</label>
              <Input className="w-20" type="number" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">₹ off / combo price</label>
              <Input className="w-24" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          {type === "HAPPY_HOUR" && (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Start</label>
                <Input className="w-24" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">End</label>
                <Input className="w-24" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-1">
            {DAYS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days.includes(d) ? "default" : "outline"}
                onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
              >
                {d}
              </Button>
            ))}
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || name.trim().length < 3}>
            <Megaphone className="h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>

      {(promosQ.data?.promotions ?? []).length === 0 ? (
        <EmptyState icon={Megaphone} title="No promotions" description="Happy hours and combo deals appear here." />
      ) : (
        <div className="space-y-2">
          {(promosQ.data?.promotions ?? []).map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-sm font-semibold">{p.name} <span className="text-xs text-muted-foreground">v{p.version}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {describe(p)}
                    {p.startTime ? ` · ${p.startTime}–${p.endTime}` : ""}
                    {p.daysOfWeek ? ` · ${JSON.parse(p.daysOfWeek).join(",")}` : ""}
                    {p.stackable ? " · stackable" : ""}
                  </div>
                </div>
                <Badge variant={p.active ? "default" : "secondary"}>{p.active ? "ACTIVE" : "PAUSED"}</Badge>
                <Button size="sm" variant="outline" onClick={() => toggle.mutate(p)}>
                  {p.active ? "Pause" : "Activate"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
