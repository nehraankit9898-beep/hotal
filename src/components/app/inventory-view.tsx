"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Package, AlertTriangle } from "lucide-react";

interface Ingredient {
  id: string;
  name: string;
  unit: string;
  stockQty: number;
  costPerUnitMinor: number;
  lowStockThreshold: number;
  active: boolean;
}
interface LedgerEntry {
  id: string;
  reason: string;
  qtyDelta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  ingredient: { name: string; unit: string };
}

/** Phase 16 — inventory: stock levels, movements, wastage, low-stock alerts. */
export function InventoryView() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("GRAM");
  const [waste, setWaste] = useState<Record<string, string>>({});

  const ingredientsQ = useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => (await api.get("/api/inventory/ingredients")) as { ingredients: Ingredient[] },
  });
  const ledgerQ = useQuery({
    queryKey: ["stock-ledger"],
    queryFn: async () => (await api.get("/api/inventory/ledger?limit=50")) as { entries: LedgerEntry[] },
  });

  const create = useMutation({
    mutationFn: async () =>
      (await api.post("/api/inventory/ingredients", { name, unit })) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Ingredient added.");
      setName("");
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const move = useMutation({
    mutationFn: async (input: { ingredientId: string; qtyDelta: number; reason: "WASTAGE" | "ADJUSTMENT"; wastageReason?: string }) =>
      (await api.post("/api/inventory/ledger", input)) as Record<string, unknown>,
    onSuccess: () => {
      toast.success("Stock movement recorded.");
      setWaste({});
      queryClient.invalidateQueries({ queryKey: ["ingredients"] });
      queryClient.invalidateQueries({ queryKey: ["stock-ledger"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const ingredients = ingredientsQ.data?.ingredients ?? [];
  const low = ingredients.filter((i) => i.stockQty <= i.lowStockThreshold);

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Inventory"
        description="Stock deducts exactly once per PAID bill from recipes. Wastage and corrections are explicit ledger entries."
      />

      {low.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Low stock: {low.map((i) => `${i.name} (${i.stockQty} ${i.unit})`).join(", ")}
        </div>
      )}

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">New ingredient</label>
            <Input className="w-52" placeholder="e.g. Paneer" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Unit</label>
            <select className="border rounded-md h-9 px-2 text-sm bg-background" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {["GRAM", "KG", "ML", "LITRE", "PIECE"].map((u) => <option key={u}>{u}</option>)}
            </select>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || name.trim().length < 2}>
            <Package className="h-4 w-4" /> Add
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {ingredients.length === 0 ? (
          <EmptyState icon={Package} title="No ingredients" description="Add ingredients, attach recipes to menu items, and stock deducts automatically on paid bills." />
        ) : (
          ingredients.map((i) => (
            <Card key={i.id}>
              <CardContent className="p-3 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold w-32 truncate">{i.name}</span>
                <Badge variant={i.stockQty <= i.lowStockThreshold ? "destructive" : "secondary"}>
                  {i.stockQty} {i.unit}
                </Badge>
                <span className="text-xs text-muted-foreground">alert ≤ {i.lowStockThreshold} {i.unit}</span>
                <span className="flex-1" />
                <Input
                  className="w-24"
                  type="number"
                  placeholder={`Qty (${i.unit})`}
                  value={waste[i.id] ?? ""}
                  onChange={(e) => setWaste((w) => ({ ...w, [i.id]: e.target.value }))}
                />
                <Button size="sm" variant="outline" onClick={() => move.mutate({ ingredientId: i.id, qtyDelta: -Math.abs(Number(waste[i.id]) || 0), reason: "WASTAGE", wastageReason: "SPOILAGE" })} disabled={!waste[i.id]}>
                  Wastage
                </Button>
                <Button size="sm" variant="outline" onClick={() => move.mutate({ ingredientId: i.id, qtyDelta: Math.abs(Number(waste[i.id]) || 0), reason: "ADJUSTMENT" })} disabled={!waste[i.id]}>
                  Add stock
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold text-sm mb-2">Recent stock movements</h3>
          {(ledgerQ.data?.entries ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements yet.</p>
          ) : (
            <div className="space-y-1 text-xs max-h-64 overflow-y-auto">
              {(ledgerQ.data?.entries ?? []).map((e) => (
                <div key={e.id} className="flex justify-between border-b py-1">
                  <span>{e.ingredient.name} · {e.reason}{e.note ? ` · ${e.note}` : ""}</span>
                  <span className={e.qtyDelta < 0 ? "text-red-600" : "text-emerald-600"}>
                    {e.qtyDelta > 0 ? "+" : ""}{e.qtyDelta} {e.ingredient.unit} → {e.balanceAfter}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
