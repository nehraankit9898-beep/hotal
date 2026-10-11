import { db } from "@/lib/db";
import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  ensureDefaultTemplates,
  isTemplateCategory,
  normalizeChannels,
  parseTemplateBinding,
} from "@/lib/templates";
import { TEMPLATE_VARIABLES } from "@/lib/personalize";

/**
 * Message templates API — Phase 6.3 (spec §20)
 * GET  /api/templates        — list (creates the 9 defaults on first load)
 * POST /api/templates        — create a custom template
 */

/** Safe variableMap parse for API responses (never throws on bad JSON). */
function safeParseVariableMap(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TEMPLATE_READ");
    if (denied) return denied;
    const { hotelId } = auth.user;

    await ensureDefaultTemplates(hotelId);

    const templates = await db.messageTemplate.findMany({
      where: { hotelId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });

    return Response.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        body: t.body,
        channels: normalizeChannels(t.channels),
        isDefault: t.isDefault,
        // RECHECK FIX (D): expose the WhatsApp provider binding so the UI can
        // manage the approval lifecycle and campaign binding honestly.
        providerTemplateId: t.providerTemplateId,
        languageCode: t.languageCode,
        variableMap: t.variableMap
          ? (safeParseVariableMap(t.variableMap) as Record<string, string>)
          : null,
        approvalStatus: t.approvalStatus,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
      variables: TEMPLATE_VARIABLES,
    });
  } catch (err) {
    return serverError(err, "Templates could not be loaded.");
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "TEMPLATE_MANAGE");
    if (denied) return denied;
    const { hotelId, userId } = auth.user;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request. Please try again.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3 || name.length > 80) {
      return jsonError("Template name must be 3–80 characters.");
    }
    const messageBody = typeof body.body === "string" ? body.body.trim() : "";
    if (messageBody.length < 10 || messageBody.length > 1000) {
      return jsonError("Template message must be 10–1000 characters.");
    }
    const category =
      typeof body.category === "string" && isTemplateCategory(body.category)
        ? body.category
        : "SPECIAL_OFFER";
    const channels = normalizeChannels(body.channels);

    // RECHECK FIX (D): templates can be created WITH their WhatsApp provider
    // binding (approval starts at DRAFT — the merchant flips it to PENDING /
    // APPROVED as Meta's lifecycle progresses).
    const binding = parseTemplateBinding(body);
    if (binding.error) return jsonError(binding.error);
    const hasBinding =
      binding.providerTemplateId !== undefined ||
      binding.languageCode !== undefined ||
      binding.variableMap !== undefined ||
      binding.approvalStatus !== undefined;

    const template = await db.messageTemplate.create({
      data: {
        hotelId,
        name,
        category,
        body: messageBody,
        channels: JSON.stringify(channels),
        isDefault: false,
        ...(hasBinding
          ? {
              providerTemplateId: binding.providerTemplateId ?? null,
              languageCode: binding.languageCode ?? null,
              variableMap: binding.variableMap ?? null,
              approvalStatus:
                binding.approvalStatus ?? (binding.providerTemplateId ? "DRAFT" : null),
            }
          : {}),
      },
    });

    await logAudit({
      req,
      hotelId,
      userId,
      action: AUDIT_ACTIONS.TEMPLATE_CREATED,
      entityType: "message_template",
      entityId: template.id,
      metadata: { name, category },
    });

    return Response.json({ ok: true, id: template.id }, { status: 201 });
  } catch (err) {
    return serverError(err, "Template could not be created.");
  }
}
