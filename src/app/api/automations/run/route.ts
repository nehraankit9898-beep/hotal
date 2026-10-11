import { db } from "@/lib/db";
import { requireAuth, jsonError, serverError } from "@/lib/api-helpers";
import { requirePermission } from "@/lib/permissions";
import { scanAutomationTriggers, runExecution } from "@/lib/automations";

/** POST /api/automations/run — scan + execute pending automations for this hotel */
export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AUTOMATION_UPDATE");
    if (denied) return denied;

    const url = new URL(req.url);
    const executionId = url.searchParams.get("executionId");

    if (executionId) {
      // Run a single execution (admin retry).
      // AUDIT FIX (F01): the execution MUST belong to the authenticated
      // hotel. runExecution performs the tenant guard — a foreign execution
      // id answers exactly like a missing one (ok:false), so tenant B can
      // never mutate tenant A's customer through this route.
      const result = await runExecution(executionId, new Date(), { hotelId: auth.user.hotelId });
      if (!result.ok) return jsonError("Execution not found in your hotel.", 404, "NOT_FOUND");
      return Response.json(result);
    }

    // Run the full scan for the hotel
    const hotel = await db.hotel.findUnique({ where: { id: auth.user.hotelId } });
    if (!hotel) return jsonError("Hotel not found.", 404);

    const result = await scanAutomationTriggers(hotel.id, hotel.name);

    return Response.json(result);
  } catch (err) {
    return serverError(err, "Automation run failed.");
  }
}

/** PUT /api/automations/run?id=<ruleId> — toggle automation status */
export async function PUT(req: Request) {
  try {
    const auth = await requireAuth(req);
    if ("response" in auth) return auth.response;
    const denied = requirePermission(auth.user, "AUTOMATION_UPDATE");
    if (denied) return denied;

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonError("Automation ID is required.");

    const rule = await db.automationRule.findFirst({ where: { id, hotelId: auth.user.hotelId } });
    if (!rule) return jsonError("Automation not found.", 404, "NOT_FOUND");

    const newStatus = rule.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    const updated = await db.automationRule.update({
      where: { id },
      data: { status: newStatus },
    });

    return Response.json({ automation: updated });
  } catch (err) {
    return serverError(err, "Could not toggle automation status.");
  }
}
