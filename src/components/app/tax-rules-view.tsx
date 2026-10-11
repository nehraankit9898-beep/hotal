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
import { Percent } from "lucide-react";

interface TaxRule {
  id: string;
  name: string;
  type: "CGST_SGST" | "IGST" | "EXEMPT";
  rateBps: number;
  isInclusive: boolean;
  scopeType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

/** Phase 14 — GST tax rules (owner-only TAX_MANAGE, server-enforced). */
export function TaxRulesView() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<"CGST_SGST" | "IGST">("CGST_SGST");
  const [ratePct, setRatePct] = useState("5");
  const [inclusive, setInclusive] = useState(true);

  const rulesQ = useQuery({
    queryKey: ["tax-rules"],
    queryFn: async () => (await api.get("/api/tax-rules")) as { taxRules: TaxRule[] },
  });

  const create = useMutation({
    mutationFn: async () =>
      (await api.post("/api/tax-rules", {
        name,
        type,
        rateBps: Math.round(Number(ratePct) * 100),
        isInclusive: inclusive,
        scopeType: "ALL",
        effectiveFrom: new Date().toISOString(),
      })) as { taxRule: TaxRule },
    onSuccess: () => {
      toast.success("Tax rule created. New bills apply it; issued bills keep their frozen snapshot.");
      setName("");
      queryClient.invalidateQueries({ queryKey: ["tax-rules"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggle = useMutation({
    mutationFn: async (r: TaxRule) =>
      (await api.patch(`/api/tax-rules/${r.id}`, { active: !r.active })) as { taxRule: TaxRule },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tax-rules"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <SectionHeading
        title="GST & tax rules"
        description="Effective-dated rules (CGST+SGST split, IGST, inclusive/exclusive). Verify current rates with your CA — the app applies exactly what you configure."
      />
      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Rule name</label>
            <Input className="w-64" placeholder="GST 5% dine-in (incl.)" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={type} onValueChange={(v) => setType(v as "CGST_SGST" | "IGST")}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CGST_SGST">CGST + SGST</SelectItem>
                <SelectItem value="IGST">IGST</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Rate %</label>
            <Input className="w-24" type="number" min="0" max="100" step="0.01" value={ratePct} onChange={(e) => setRatePct(e.target.value)} />
          </div>
          <Button variant={inclusive ? "default" : "outline"} size="sm" onClick={() => setInclusive(!inclusive)}>
            {inclusive ? "Prices include tax" : "Prices exclude tax"}
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || name.trim().length < 3}>
            <Percent className="h-4 w-4" /> Add rule
          </Button>
        </CardContent>
      </Card>

      {(rulesQ.data?.taxRules ?? []).length === 0 ? (
        <EmptyState icon={Percent} title="No tax rules" description="Without rules, bills are untaxed. Add your GST rule after confirming rates." />
      ) : (
        <div className="space-y-2">
          {(rulesQ.data?.taxRules ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-sm font-semibold">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.type === "CGST_SGST" ? `CGST ${(r.rateBps / 200).toFixed(2)}% + SGST ${(r.rateBps / 200).toFixed(2)}%` : `IGST ${(r.rateBps / 100).toFixed(2)}%`} ·{" "}
                    {r.isInclusive ? "inclusive" : "exclusive"} · from {r.effectiveFrom.slice(0, 10)}
                  </div>
                </div>
                <Badge variant={r.active ? "default" : "secondary"}>{r.active ? "ACTIVE" : "INACTIVE"}</Badge>
                <Button size="sm" variant="outline" onClick={() => toggle.mutate(r)}>
                  {r.active ? "Deactivate" : "Activate"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
