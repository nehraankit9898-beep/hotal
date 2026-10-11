"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import type { TemplatesResponse, TemplateRow } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, SectionHeading } from "@/components/app/shared-ui";
import { useToast } from "@/hooks/use-toast";
import { MessageSquareText, Plus, Loader2, Pencil, Trash2, Info } from "lucide-react";

const CATEGORY_LABELS: Record<string, string> = {
  WELCOME: "Welcome",
  THANK_YOU: "Thank you",
  COME_BACK: "Come back",
  BIRTHDAY: "Birthday",
  SPECIAL_OFFER: "Special offer",
  FESTIVAL_OFFER: "Festival",
  LOYALTY_REWARD: "Loyalty reward",
  INACTIVE_WINBACK: "Win-back",
  VIP_APPRECIATION: "VIP",
};

export function TemplatesView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => api.get<TemplatesResponse>("/api/templates"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onSuccess: () => {
      toast({ title: "Template deleted" });
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not delete",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const templates = data?.templates ?? [];

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Message Templates"
        description="Ready-made messages for every occasion. Personalize with {{name}}, {{offer}} and more — then pick one while building a campaign."
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> New Template
          </Button>
        }
      />

      {data?.variables?.length ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="font-medium text-foreground">Supported variables:</span>
          {data.variables.map((v) => (
            <code
              key={v.key}
              title={v.description}
              className="rounded bg-background border px-1.5 py-0.5 text-[11px]"
            >
              {v.key}
            </code>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No templates"
          description="Create reusable messages for welcomes, win-backs and festival offers."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{t.name}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[11px]">
                        {CATEGORY_LABELS[t.category] ?? t.category}
                      </Badge>
                      {t.isDefault ? (
                        <Badge variant="secondary" className="text-[11px]">
                          Default
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>
                <p className="mt-3 flex-1 rounded-lg bg-muted/60 p-3 text-sm leading-relaxed text-muted-foreground line-clamp-4">
                  {t.body}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Channels: {t.channels.join(", ")}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setEditing(t)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                  </Button>
                  {!t.isDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TemplateDialog
        open={creating || !!editing}
        template={editing}
        categories={Object.keys(CATEGORY_LABELS)}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function TemplateDialog({
  open,
  template,
  categories,
  onClose,
}: {
  open: boolean;
  template: TemplateRow | null;
  categories: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      template
        ? api.patch(`/api/templates/${template.id}`, payload)
        : api.post("/api/templates", payload),
    onSuccess: () => {
      toast({ title: template ? "Template updated" : "Template created" });
      qc.invalidateQueries({ queryKey: ["templates"] });
      onClose();
    },
    onError: (err: unknown) => {
      toast({
        title: "Could not save template",
        description: err instanceof ApiError ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Use variables like {"{{name}}"} and {"{{offer}}"} — they're filled in automatically for
            each customer.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <TemplateForm
            key={template?.id ?? "new"}
            template={template}
            categories={categories}
            saving={mutation.isPending}
            onSubmit={(payload) => mutation.mutate(payload)}
            onCancel={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({
  template,
  categories,
  saving,
  onSubmit,
  onCancel,
}: {
  template: TemplateRow | null;
  categories: string[];
  saving: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState(template?.category ?? "SPECIAL_OFFER");
  const [body, setBody] = useState(template?.body ?? "");
  const [channel, setChannel] = useState(template?.channels[0] ?? "WHATSAPP");

  const valid = name.trim().length >= 3 && body.trim().length >= 10;

  return (
    <>
      <div className="space-y-3">
        <div>
          <Label htmlFor="tp-name">Name</Label>
          <Input
            id="tp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Diwali Special"
            className="mt-1"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Primary channel</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
                <SelectItem value="SMS">SMS</SelectItem>
                <SelectItem value="EMAIL">Email</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="tp-body">Message</Label>
          <Textarea
            id="tp-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="Hi {{name}}, enjoy {{offer}} at {{hotel_name}}!"
            className="mt-1"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{body.length}/1000 characters</p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!valid || saving}
          onClick={() =>
            onSubmit({ name: name.trim(), category, body: body.trim(), channels: [channel] })
          }
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
        </Button>
      </DialogFooter>
    </>
  );
}
