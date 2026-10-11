"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { Utensils, Plus, Pencil, Archive, Leaf, Flame } from "lucide-react";

interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  itemCount: number;
}

interface OptionGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: { id: string; name: string; priceDeltaMinor: number; sortOrder: number }[];
}

interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  dietaryTags: string | null;
  imageUrl: string | null;
  active: boolean;
  available: boolean;
  prepMinutes: number;
  sortOrder: number;
  optionGroups?: OptionGroup[];
}

const rupees = (minor: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(
    minor / 100,
  );

function parseTags(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function MenuView({ user }: { user: { role: string } }) {
  const queryClient = useQueryClient();
  const canManage = ["HOTEL_OWNER", "HOTEL_ADMIN", "HOTEL_MANAGER", "RESTAURANT_MANAGER"].includes(user.role);
  const canToggleAvailability = canManage || user.role === "KITCHEN_STAFF";

  const [categoryDialog, setCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState<MenuCategory | null>(null);
  const [itemDialog, setItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<MenuItem | null>(null);

  const { data: catData, isLoading: catsLoading } = useQuery({
    queryKey: ["menu-categories"],
    queryFn: () => api.get<{ categories: MenuCategory[] }>("/api/menu/categories"),
  });
  const { data: itemData, isLoading: itemsLoading } = useQuery({
    queryKey: ["menu-items"],
    queryFn: () => api.get<{ items: MenuItem[] }>("/api/menu/items?includeArchived=1"),
  });

  const availability = useMutation({
    mutationFn: ({ id, available }: { id: string; available: boolean }) =>
      api.patch(`/api/menu/items/${id}/availability`, { available }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items"] });
      toast.success("Availability updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const archiveItem = useMutation({
    mutationFn: (id: string) => api.delete(`/api/menu/items/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items"] });
      queryClient.invalidateQueries({ queryKey: ["menu-categories"] });
      setConfirmArchive(null);
      toast.success("Item archived — past orders keep their history");
    },
    onError: (e) => toast.error(e.message),
  });

  const categories = catData?.categories ?? [];
  const items = itemData?.items ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Digital Menu"
        description="Your QR menu catalog — categories, items, options and pricing. Changes go live on the public menu instantly."
      />

      <div className="flex flex-wrap items-center gap-2">
        {canManage && (
          <Button
            onClick={() => {
              setEditingCategory(null);
              setCategoryDialog(true);
            }}
            variant="outline"
            size="sm"
          >
            <Plus className="mr-1.5 h-4 w-4" /> Category
          </Button>
        )}
        {canManage && (
          <Button
            onClick={() => {
              setEditingItem(null);
              setItemDialog(true);
            }}
            size="sm"
          >
            <Plus className="mr-1.5 h-4 w-4" /> Menu item
          </Button>
        )}
      </div>

      {catsLoading || itemsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : categories.length === 0 ? (
        <EmptyState
          icon={Utensils}
          title="No menu categories yet"
          description="Create your first category (Starters, Mains, Drinks…) to start building the QR menu."
        />
      ) : (
        <div className="space-y-6">
          {categories.map((cat) => {
            const catItems = items.filter((i) => i.categoryId === cat.id);
            return (
              <Card key={cat.id}>
                <CardContent className="p-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold">{cat.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {cat.itemCount} item{cat.itemCount === 1 ? "" : "s"}
                        {cat.description ? ` · ${cat.description}` : ""}
                      </p>
                    </div>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingCategory(cat);
                          setCategoryDialog(true);
                        }}
                      >
                        <Pencil className="mr-1 h-3.5 w-3.5" /> Rename
                      </Button>
                    )}
                  </div>

                  {catItems.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                      No items in this category yet.
                    </p>
                  ) : (
                    <div className="divide-y rounded-lg border">
                      {catItems.map((item) => {
                        const tags = parseTags(item.dietaryTags);
                        return (
                          <div key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-medium">{item.name}</p>
                                {tags.includes("VEG") && (
                                  <Badge variant="outline" className="gap-1 border-green-600/40 text-green-700">
                                    <Leaf className="h-3 w-3" /> Veg
                                  </Badge>
                                )}
                                {tags.includes("NON_VEG") && (
                                  <Badge variant="outline" className="gap-1 border-red-600/40 text-red-700">
                                    Non-veg
                                  </Badge>
                                )}
                                {tags.includes("SPICY") && (
                                  <Badge variant="outline" className="gap-1 border-orange-500/40 text-orange-600">
                                    <Flame className="h-3 w-3" /> Spicy
                                  </Badge>
                                )}
                                {item.optionGroups && item.optionGroups.length > 0 && (
                                  <Badge variant="secondary">{item.optionGroups.length} option group(s)</Badge>
                                )}
                                {!item.active && <Badge variant="destructive">Archived</Badge>}
                              </div>
                              {item.description && (
                                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{item.description}</p>
                              )}
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                ~{item.prepMinutes} min prep · #{item.sortOrder}
                              </p>
                            </div>
                            <p className="text-sm font-semibold tabular-nums">{rupees(item.priceMinor)}</p>
                            <div className="flex items-center gap-2">
                              {canToggleAvailability && item.active && (
                                <Switch
                                  checked={item.available}
                                  disabled={availability.isPending}
                                  aria-label={`Toggle availability for ${item.name}`}
                                  onCheckedChange={(v) => availability.mutate({ id: item.id, available: v })}
                                />
                              )}
                              {canManage && (
                                <>
                                  <Button variant="ghost" size="icon" aria-label={`Edit ${item.name}`} onClick={() => {
                                    setEditingItem(item);
                                    setItemDialog(true);
                                  }}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Archive ${item.name}`}
                                    onClick={() => setConfirmArchive(item)}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CategoryDialog
        open={categoryDialog}
        onOpenChange={setCategoryDialog}
        editing={editingCategory}
        onSaved={() => {
          setCategoryDialog(false);
          queryClient.invalidateQueries({ queryKey: ["menu-categories"] });
        }}
      />

      <ItemDialog
        open={itemDialog}
        onOpenChange={setItemDialog}
        editing={editingItem}
        categories={categories}
        onSaved={() => {
          setItemDialog(false);
          queryClient.invalidateQueries({ queryKey: ["menu-items"] });
          queryClient.invalidateQueries({ queryKey: ["menu-categories"] });
        }}
      />

      <Dialog open={confirmArchive !== null} onOpenChange={(v) => !v && setConfirmArchive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive “{confirmArchive?.name}”?</DialogTitle>
            <DialogDescription>
              The item disappears from the QR menu immediately. Past orders keep their line-item history. This can be
              undone only by creating the item again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmArchive(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmArchive && archiveItem.mutate(confirmArchive.id)}
              disabled={archiveItem.isPending}
            >
              Archive item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CategoryDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: MenuCategory | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [key, setKey] = useState(0);

  // reset fields when the dialog opens for a different target
  const targetKey = `${editing?.id ?? "new"}-${open}`;
  if (key !== targetKey.length + (editing ? 1 : 0) + name.length * 0 + targetKey.charCodeAt(0)) {
    setKey(targetKey.length + (editing ? 1 : 0) + targetKey.charCodeAt(0));
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
  }

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api.patch(`/api/menu/categories/${editing.id}`, { name, description })
        : api.post("/api/menu/categories", { name, description }),
    onSuccess: () => {
      toast.success(editing ? "Category updated" : "Category created");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Rename category" : "New category"}</DialogTitle>
          <DialogDescription>
            Categories order the QR menu. Keep names short — they are the section headers diners see.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cat-name">Name</Label>
            <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Starters" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-desc">Description (optional)</Label>
            <Textarea
              id="cat-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Small plates to share"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || name.trim().length < 2}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ItemForm {
  name: string;
  description: string;
  categoryId: string;
  priceRupees: string;
  prepMinutes: string;
  veg: boolean;
  nonVeg: boolean;
  spicy: boolean;
}

function ItemDialog({
  open,
  onOpenChange,
  editing,
  categories,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: MenuItem | null;
  categories: MenuCategory[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ItemForm>({
    name: "",
    description: "",
    categoryId: "",
    priceRupees: "",
    prepMinutes: "10",
    veg: true,
    nonVeg: false,
    spicy: false,
  });
  const [key, setKey] = useState("");

  const tags = editing ? parseTags(editing.dietaryTags) : [];
  const targetKey = `${editing?.id ?? "new"}-${open}`;
  if (key !== targetKey) {
    setKey(targetKey);
    setForm({
      name: editing?.name ?? "",
      description: editing?.description ?? "",
      categoryId: editing?.categoryId ?? categories[0]?.id ?? "",
      priceRupees: editing ? String(editing.priceMinor / 100) : "",
      prepMinutes: String(editing?.prepMinutes ?? 10),
      veg: editing ? tags.includes("VEG") : true,
      nonVeg: editing ? tags.includes("NON_VEG") : false,
      spicy: editing ? tags.includes("SPICY") : false,
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const dietaryTags = [
        ...(form.veg && !form.nonVeg ? ["VEG"] : []),
        ...(form.nonVeg ? ["NON_VEG"] : []),
        ...(form.spicy ? ["SPICY"] : []),
      ];
      const priceMinor = Math.round(Number(form.priceRupees) * 100);
      // BUG-7: an invalid price ("2.5.5" → NaN → JSON null → ₹0 item on the
      // server) is rejected CLIENT-side before the request is sent.
      if (!Number.isFinite(priceMinor) || priceMinor < 0) {
        toast.error("Enter a valid price in rupees (e.g. 250 or 250.50).");
        return Promise.reject(new Error("invalid price"));
      }
      if (editing) {
        return api.patch(`/api/menu/items/${editing.id}`, {
          name: form.name,
          description: form.description,
          priceMinor,
          prepMinutes: Number(form.prepMinutes),
          dietaryTags,
        });
      }
      return api.post("/api/menu/items", {
        name: form.name,
        description: form.description,
        categoryId: form.categoryId,
        priceMinor,
        prepMinutes: Number(form.prepMinutes),
        dietaryTags,
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Item updated" : "Item added to the menu");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit “${editing.name}”` : "New menu item"}</DialogTitle>
          <DialogDescription>
            Prices are stored in paise (integer minor units) and always re-validated server-side on every order.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="item-name">Name</Label>
            <Input
              id="item-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Paneer Tikka"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="item-price">Price (₹)</Label>
              <Input
                id="item-price"
                inputMode="decimal"
                value={form.priceRupees}
                onChange={(e) => setForm({ ...form, priceRupees: e.target.value })}
                placeholder="250"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="item-prep">Prep time (min)</Label>
              <Input
                id="item-prep"
                inputMode="numeric"
                value={form.prepMinutes}
                onChange={(e) => setForm({ ...form, prepMinutes: e.target.value })}
              />
            </div>
          </div>
          {!editing && (
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="item-desc">Description (optional)</Label>
            <Textarea
              id="item-desc"
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Char-grilled cottage cheese with mint chutney"
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={form.veg && !form.nonVeg}
                onChange={(e) => setForm({ ...form, veg: e.target.checked, nonVeg: e.target.checked ? false : form.nonVeg })}
              />
              Veg
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={form.nonVeg}
                onChange={(e) => setForm({ ...form, nonVeg: e.target.checked, veg: e.target.checked ? false : form.veg })}
              />
              Non-veg
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={form.spicy}
                onChange={(e) => setForm({ ...form, spicy: e.target.checked })}
              />
              Spicy
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || form.name.trim().length < 2 || !form.priceRupees || (!editing && !form.categoryId)}
          >
            {editing ? "Save changes" : "Add to menu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
