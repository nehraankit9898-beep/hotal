import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { isTemplateCategory, normalizeChannels, parseTemplateBinding } from "@/lib/templates";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Template detail API — Phase 6.3
 * PATCH  /api/templates/[id] — edit (defaults editable too, per spec "owners customize templates")
 * DELETE /api/templates/[id] — delete (only custom templates)
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TEMPLATE_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const template = await db.messageTemplate.findFirst({ where: { id, hotelId } });
    if (!template) return jsonError("Template not found in your hotel.", 404, "NOT_FOUND");

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (body.name !== undefined && (name.length < 3 || name.length > 80)) {
      return jsonError("Template name must be 3–80 characters.");
    }
    const messageBody = typeof body.body === "string" ? body.body.trim() : "";
    if (body.body !== undefined && (messageBody.length < 10 || messageBody.length > 1000)) {
      return jsonError("Template message must be 10–1000 characters.");
    }
    const category =
      typeof body.category === "string" && isTemplateCategory(body.category) ? body.category : null;
    const channels =
      body.channels !== undefined ? JSON.stringify(normalizeChannels(body.channels)) : null;

    // RECHECK FIX (D): provider binding is editable (approval lifecycle +
    // provider template name + language + positional variable map).
    const binding = parseTemplateBinding(body);
    if (binding.error) return jsonError(binding.error);

    const updated = await db.messageTemplate.update({
      where: { id: template.id },
      data: {
        ...(name ? { name } : {}),
        ...(messageBody ? { body: messageBody } : {}),
        ...(category ? { category } : {}),
        ...(channels ? { channels } : {}),
        ...(binding.providerTemplateId !== undefined
          ? { providerTemplateId: binding.providerTemplateId }
          : {}),
        ...(binding.languageCode !== undefined ? { languageCode: binding.languageCode } : {}),
        ...(binding.variableMap !== undefined ? { variableMap: binding.variableMap } : {}),
        ...(binding.approvalStatus !== undefined ? { approvalStatus: binding.approvalStatus } : {}),
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.TEMPLATE_UPDATED,
      entityType: "message_template",
      entityId: updated.id,
      metadata: { name: updated.name, category: updated.category },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Template could not be updated.");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TEMPLATE_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;
    const { id } = await ctx.params;

    const template = await db.messageTemplate.findFirst({ where: { id, hotelId } });
    if (!template) return jsonError("Template not found in your hotel.", 404, "NOT_FOUND");
    if (template.isDefault) {
      return jsonError("Default templates cannot be deleted. You can edit them instead.");
    }

    await db.messageTemplate.delete({ where: { id: template.id } });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.TEMPLATE_DELETED,
      entityType: "message_template",
      entityId: template.id,
      metadata: { name: template.name },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err, "Template could not be deleted.");
  }
}
