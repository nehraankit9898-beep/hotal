"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { CustomerRow } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, UserPlus, Pencil, Info, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Dialog content unmounts on close (Radix), so form state naturally
 * resets each time the dialog is opened — no effects needed.
 */
export function CustomerDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: CustomerRow | null;
  onSaved?: (customer: CustomerRow) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <CustomerForm editing={editing ?? null} onOpenChange={onOpenChange} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

function CustomerForm({
  editing,
  onOpenChange,
  onSaved,
}: {
  editing: CustomerRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (customer: CustomerRow) => void;
}) {
  const isEdit = !!editing;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(editing?.name ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [consent, setConsent] = useState(editing?.marketingConsent ?? false);
  // Phase 6.4 — channel-level opt-ins (only meaningful with consent)
  const [optWhatsapp, setOptWhatsapp] = useState(editing?.whatsappOptIn ?? false);
  const [optSms, setOptSms] = useState(editing?.smsOptIn ?? false);
  const [optEmail, setOptEmail] = useState(editing?.emailOptIn ?? false);
  const [error, setError] = useState<string | null>(null);
  // Phase 2 intelligence fields
  const [roomPreference, setRoomPreference] = useState(editingRoomPref(editing) ?? "");
  const [foodPreference, setFoodPreference] = useState(editingFoodPref(editing) ?? "");
  const [location, setLocation] = useState(editingLocation(editing) ?? "");
  const [birthday, setBirthday] = useState(toDateInput(editingBirthday(editing)));
  const [anniversary, setAnniversary] = useState(toDateInput(editingAnniversary(editing)));
  const [source, setSource] = useState(editingSource(editing) ?? "");
  const [notes, setNotes] = useState(editingNotes(editing) ?? "");
  const [vip, setVip] = useState(editing?.vip ?? false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        return api.patch<{ customer: CustomerRow }>(`/api/customers/${editing!.id}`, {
          name,
          phone,
          email,
          marketingConsent: consent,
          whatsappOptIn: optWhatsapp,
          smsOptIn: optSms,
          emailOptIn: optEmail,
          roomPreference: roomPreference,
          foodPreference: foodPreference,
          location: location,
          birthday: birthday || null,
          anniversary: anniversary || null,
          source: source || null,
          notes: notes,
          vip,
        });
      }
      return api.post<{ customer: CustomerRow }>("/api/customers", {
        name,
        phone,
        email,
        marketingConsent: consent,
        whatsappOptIn: optWhatsapp,
        smsOptIn: optSms,
        emailOptIn: optEmail,
        consentSource: "MANUAL_ENTRY",
        roomPreference: roomPreference || undefined,
        foodPreference: foodPreference || undefined,
        location: location || undefined,
        birthday: birthday || undefined,
        anniversary: anniversary || undefined,
        source: source || undefined,
        notes: notes || undefined,
        vip,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["audit"] });
      toast({
        title: isEdit ? "Customer updated" : "Customer added",
        description: isEdit
          ? `${name}'s details were saved.`
          : `${name} is now in your guest list.`,
      });
      onOpenChange(false);
      onSaved?.(res.customer);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError ? err.message : "Customer could not be saved. Please try again.",
      );
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {isEdit ? (
            <>
              <Pencil className="h-4 w-4 text-primary" /> Edit customer
            </>
          ) : (
            <>
              <UserPlus className="h-4 w-4 text-primary" /> Add customer
            </>
          )}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? "Update this guest's basic details."
            : "Add a guest to your hotel's customer list."}
        </DialogDescription>
      </DialogHeader>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="c-name">Full name *</Label>
          <Input
            id="c-name"
            placeholder="e.g. Rahul Sharma"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="c-phone">Phone number *</Label>
          <Input
            id="c-phone"
            placeholder="+91 98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
          <p className="text-[11px] text-muted-foreground">
            We&apos;ll clean up the format automatically. One phone number per guest.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="c-email">Email (optional)</Label>
          <Input
            id="c-email"
            type="email"
            placeholder="guest@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="rounded-lg border bg-accent/40 p-3.5">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={consent}
              onCheckedChange={(v) => {
                setConsent(v === true);
                if (v !== true) {
                  // Revoking marketing consent revokes every channel with it.
                  setOptWhatsapp(false);
                  setOptSms(false);
                  setOptEmail(false);
                }
              }}
              className="mt-0.5"
            />
            <span className="text-[13px] leading-snug">
              I confirm this guest <span className="font-semibold">agreed to receive</span>{" "}
              promotional offers and updates from this hotel.
            </span>
          </label>
          {consent && (
            <div className="mt-2.5 ml-8 space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Which channels did they agree to?
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {[
                  { label: "WhatsApp", checked: optWhatsapp, set: setOptWhatsapp },
                  { label: "SMS", checked: optSms, set: setOptSms },
                  { label: "Email", checked: optEmail, set: setOptEmail },
                ].map((ch) => (
                  <label
                    key={ch.label}
                    className="flex cursor-pointer items-center gap-2 text-[13px]"
                  >
                    <Checkbox checked={ch.checked} onCheckedChange={(v) => ch.set(v === true)} />
                    {ch.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 flex items-start gap-1.5 pl-8 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            Only tick this if the guest actually said yes. Each channel is checked separately before
            any campaign can contact them.
          </p>
        </div>

        {/* Phase 2: guest intelligence */}
        <div className="rounded-lg border p-3.5 space-y-4">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Guest intelligence (optional) — powers
            segments &amp; personalised campaigns
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-room">Room preference</Label>
              <Input
                id="c-room"
                placeholder="e.g. Deluxe, Sea View"
                value={roomPreference}
                onChange={(e) => setRoomPreference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-food">Food preference</Label>
              <Input
                id="c-food"
                placeholder="e.g. Veg, Jain"
                value={foodPreference}
                onChange={(e) => setFoodPreference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-location">City / location</Label>
              <Input
                id="c-location"
                placeholder="e.g. Mumbai"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger aria-label="Customer source">
                  <SelectValue placeholder="How did they find you?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WALK_IN">Walk-in</SelectItem>
                  <SelectItem value="BOOKING">Booking</SelectItem>
                  <SelectItem value="WEBSITE">Website</SelectItem>
                  <SelectItem value="REFERRAL">Referral</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-birthday">Birthday</Label>
              <Input
                id="c-birthday"
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-anniversary">Anniversary</Label>
              <Input
                id="c-anniversary"
                type="date"
                value={anniversary}
                onChange={(e) => setAnniversary(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-notes">Notes</Label>
            <Textarea
              id="c-notes"
              placeholder="Anything worth remembering — favourite room, allergic to nuts, celebrates here…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="resize-none"
            />
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <Checkbox checked={vip} onCheckedChange={(v) => setVip(v === true)} />
            <span className="text-[13px]">
              Mark as <span className="font-semibold">VIP</span> guest
            </span>
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </>
            ) : isEdit ? (
              "Save changes"
            ) : (
              "Add customer"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// Accessors for Phase 2 fields that may exist on the editing row
function editingRoomPref(c: CustomerRow | null): string | null {
  return (c as unknown as { roomPreference?: string | null } | null)?.roomPreference ?? null;
}
function editingFoodPref(c: CustomerRow | null): string | null {
  return (c as unknown as { foodPreference?: string | null } | null)?.foodPreference ?? null;
}
function editingLocation(c: CustomerRow | null): string | null {
  return (c as unknown as { location?: string | null } | null)?.location ?? null;
}
function editingBirthday(c: CustomerRow | null): string | null {
  return (c as unknown as { birthday?: string | null } | null)?.birthday ?? null;
}
function editingAnniversary(c: CustomerRow | null): string | null {
  return (c as unknown as { anniversary?: string | null } | null)?.anniversary ?? null;
}
function editingSource(c: CustomerRow | null): string | null {
  return (c as unknown as { source?: string | null } | null)?.source ?? null;
}
function editingNotes(c: CustomerRow | null): string | null {
  return (c as unknown as { notes?: string | null } | null)?.notes ?? null;
}
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
