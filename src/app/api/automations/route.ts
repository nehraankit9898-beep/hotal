import { db } from "@/lib/db";

import { requireAuth, jsonError, readJson, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { logAudit, AUDIT_ACTIONS } from "@/lib/audit";

/** GET /api/automations — list automation rules + recent executions */
export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AUTOMATION_READ");
    if (denied) return denied;

    const rules = await db.automationRule.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { executions: true } } },
    });

    const recentExecutions = await db.automationExecution.findMany({
      where: { hotelId: auth.user.hotelId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        customer: { select: { name: true, phone: true } },
        automation: { select: { name: true, trigger: true } },
      },
    });

    const todayStats = await db.automationExecution.aggregate({
      where: {
        hotelId: auth.user.hotelId,
        executedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
      _count: { _all: true },
    });

    return Response.json({
      automations: rules.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        trigger: r.trigger,
        waitDays: r.waitDays,
        conditions: r.conditions,
        actions: r.actions,
        channels: r.channels,
        messageTemplate: r.messageTemplate,
        offer: r.offer,
        status: r.status,
        runsCount: r.runsCount,
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        executionsCount: r._count.executions,
        createdAt: r.createdAt.toISOString(),
      })),
      recentExecutions: recentExecutions.map((e) => ({
        id: e.id,
        automation: e.automation,
        customer: e.customer,
        trigger: e.trigger,
        status: e.status,
        scheduledAt: e.scheduledAt.toISOString(),
        executedAt: e.executedAt?.toISOString() ?? null,
        failureReason: e.failureReason,
        result: e.result,
      })),
      stats: {
        totalExecutionsToday: todayStats._count._all,
      },
    });
  } catch (err) {
    return serverError(err, "Automations could not be loaded.");
  }
}

/** POST /api/automations — create a new automation rule */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AUTOMATION_CREATE");
    if (denied) return denied;

    const body = await readJson(req);
    if (!body) return jsonError("Invalid request.");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 3)
      return jsonError("Please enter an automation name (at least 3 characters).");

    const trigger = typeof body.trigger === "string" ? body.trigger : "";
    const validTriggers = [
      "HOTEL_CHECKOUT",
      "RESTAURANT_VISIT",
      "INACTIVE_7",
      "INACTIVE_15",
      "INACTIVE_30",
      "BIRTHDAY",
      "ANNIVERSARY",
      "VIP_THRESHOLD",
      "OFFER_UNUSED",
      "REPEAT_VISIT",
      "SPECIAL_EVENT",
    ];
    if (!validTriggers.includes(trigger)) {
      return jsonError("Please select a valid trigger for this automation.");
    }

    const rule = await db.automationRule.create({
      data: {
        hotelId: auth.user.hotelId,
        name,
        description:
          typeof body.description === "string" ? body.description.slice(0, 300) || null : null,
        trigger: trigger as never,
        waitDays: Number(body.waitDays ?? 0),
        conditions: body.conditions ? JSON.stringify(body.conditions) : null,
        actions: JSON.stringify(body.actions ?? []),
        channels: JSON.stringify(body.channels ?? ["WHATSAPP"]),
        messageTemplate: typeof body.messageTemplate === "string" ? body.messageTemplate : null,
        offer: typeof body.offer === "string" ? body.offer || null : null,
        status: "DRAFT",
      },
    });

    await logAudit({
      req,
      hotelId: auth.user.hotelId,
      userId: auth.user.userId,
      action: AUDIT_ACTIONS.CAMPAIGN_CREATED,
      entityType: "automation_rule",
      entityId: rule.id,
      metadata: { name, trigger },
    });

    return Response.json({ automation: rule }, { status: 201 });
  } catch (err) {
    return serverError(err, "Automation could not be created.");
  }
}
