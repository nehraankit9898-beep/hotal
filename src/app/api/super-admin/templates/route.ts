import { NextResponse } from "next/server";
import { readJson, jsonError, serverError, requireSuperAdminSession } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/**
 * Platform notification templates — Phase 10 §19 (Super Admin only).
 *   GET /api/super-admin/templates      → all templates
 *   PUT /api/super-admin/templates      → { key, subject?, body, isActive? }
 * Templates support {{tenant_name}} / {{customer_name}} / {{trial_days}} /
 * {{plan_name}} / {{amount}} variables and are validated before saving.
 */
const SUPPORTED_VARIABLES = [
  "tenant_name",
  "customer_name",
  "trial_days",
  "plan_name",
  "amount",
  "days_remaining",
  "invoice_number",
  "expiry_date",
  "hotel_name",
  "reason",
];

const DEFAULT_TEMPLATES: {
  key: string;
  name: string;
  channel: string;
  subject: string;
  body: string;
}[] = [
  {
    key: "trial_started",
    name: "Trial started",
    channel: "EMAIL",
    subject: "Your StayLoop trial has started",
    body: "Hi {{tenant_name}},\n\nYour {{plan_name}} trial is now active for {{trial_days}} days. Explore everything StayLoop has to offer!\n\n— Team StayLoop",
  },
  {
    key: "trial_ending",
    name: "Trial ending soon",
    channel: "EMAIL",
    subject: "Your StayLoop trial ends in {{days_remaining}} days",
    body: "Hi {{tenant_name}},\n\nYour trial ends in {{days_remaining}} days. Upgrade to keep your campaigns, loyalty and guest data flowing.\n\n— Team StayLoop",
  },
  {
    key: "trial_expired",
    name: "Trial expired",
    channel: "EMAIL",
    subject: "Your StayLoop trial has expired",
    body: "Hi {{tenant_name}},\n\nYour trial period has ended. Choose a plan any time to reactivate your workspace.\n\n— Team StayLoop",
  },
  {
    key: "payment_successful",
    name: "Payment successful",
    channel: "EMAIL",
    subject: "Payment received — invoice {{invoice_number}}",
    body: "Hi {{tenant_name}},\n\nWe received your payment of {{amount}} for the {{plan_name}} plan. Invoice: {{invoice_number}}.\n\n— Team StayLoop",
  },
  {
    key: "payment_failed",
    name: "Payment failed",
    channel: "EMAIL",
    subject: "Payment failed for invoice {{invoice_number}}",
    body: "Hi {{tenant_name}},\n\nYour payment of {{amount}} could not be processed. Please retry or contact billing.\n\n— Team StayLoop",
  },
  {
    key: "subscription_renewed",
    name: "Subscription renewed",
    channel: "EMAIL",
    subject: "Your StayLoop subscription renewed",
    body: "Hi {{tenant_name}},\n\nYour {{plan_name}} subscription has been renewed successfully.\n\n— Team StayLoop",
  },
  {
    key: "subscription_cancelled",
    name: "Subscription cancelled",
    channel: "EMAIL",
    subject: "Subscription cancelled",
    body: "Hi {{tenant_name}},\n\nYour subscription has been cancelled. Reason: {{reason}}.\n\n— Team StayLoop",
  },
  {
    key: "welcome",
    name: "Welcome",
    channel: "EMAIL",
    subject: "Welcome to StayLoop",
    body: "Hi {{tenant_name}},\n\nWelcome to StayLoop — turn one-time guests into loyal regulars.\n\n— Team StayLoop",
  },
  {
    key: "password_reset",
    name: "Password reset",
    channel: "EMAIL",
    subject: "Reset your StayLoop password",
    body: "Hi {{customer_name}},\n\nUse the link below to reset your password. The link expires soon.\n\n— Team StayLoop",
  },
  {
    key: "mfa",
    name: "MFA",
    channel: "EMAIL",
    subject: "StayLoop security change",
    body: "Hi {{customer_name}},\n\nMulti-factor authentication was changed on your account. If this wasn't you, contact support immediately.\n\n— Team StayLoop",
  },
  {
    key: "security_alert",
    name: "Security alert",
    channel: "EMAIL",
    subject: "Security alert for your account",
    body: "Hi {{customer_name}},\n\nWe detected unusual activity on your account. If this wasn't you, contact support immediately.\n\n— Team StayLoop",
  },
];

async function ensureTemplatesSeeded() {
  for (const t of DEFAULT_TEMPLATES) {
    await db.platformNotificationTemplate.upsert({
      where: { key: t.key },
      create: {
        key: t.key,
        name: t.name,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        variables: JSON.stringify(SUPPORTED_VARIABLES),
      },
      update: {},
    });
  }
}

function validateTemplate(body: string): string | null {
  if (!body.trim()) return "Template body cannot be empty.";
  if (body.length > 5000) return "Template body is too long (max 5000 characters).";
  const used = body.match(/\{\{([^}]+)\}\}/g) ?? [];
  for (const raw of used) {
    const name = raw.slice(2, -2).trim();
    if (!SUPPORTED_VARIABLES.includes(name)) {
      return `Unknown template variable: {{${name}}}. Supported: ${SUPPORTED_VARIABLES.join(", ")}`;
    }
  }
  return null;
}

export async function GET(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    await ensureTemplatesSeeded();
    const templates = await db.platformNotificationTemplate.findMany({ orderBy: { key: "asc" } });
    return NextResponse.json({
      templates: templates.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        channel: t.channel,
        subject: t.subject,
        body: t.body,
        isActive: t.isActive,
        supportedVariables: SUPPORTED_VARIABLES,
        updatedAt: t.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    return serverError(err, "Could not load notification templates.");
  }
}

export async function PUT(req: Request) {
  const guard = await requireSuperAdminSession(req);
  if ("response" in guard) return guard.response;
  try {
    const body = await readJson(req);
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const templateBody = typeof body?.body === "string" ? body.body : "";
    if (!key) return jsonError("Template key is required.", 422, "VALIDATION_ERROR");
    const invalid = validateTemplate(templateBody);
    if (invalid) return jsonError(invalid, 422, "VALIDATION_ERROR");
    const existing = await db.platformNotificationTemplate.findUnique({ where: { key } });
    if (!existing) return jsonError("Template not found.", 404, "NOT_FOUND");
    await db.platformNotificationTemplate.update({
      where: { key },
      data: {
        subject: typeof body?.subject === "string" ? body.subject.slice(0, 300) : existing.subject,
        body: templateBody,
        isActive: body?.isActive === undefined ? existing.isActive : body.isActive === true,
        updatedBy: guard.session.userId,
      },
    });
    await logAudit({
      userId: guard.session.userId,
      action: AUDIT_ACTIONS.NOTIFICATION_TEMPLATE_UPDATED,
      entityType: "notification_template",
      entityId: key,
      metadata: { key },
      req,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "Could not update the template.");
  }
}
